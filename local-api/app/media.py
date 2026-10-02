"""Authenticated, bounded, temporary Twilio media downloads."""

from __future__ import annotations

import os
import re
import shutil
import tempfile
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator, Sequence
from urllib.parse import urlsplit

import httpx


TWILIO_ACCOUNT_SID_ENV = "NRM_TWILIO_ACCOUNT_SID"
TWILIO_AUTH_TOKEN_ENV = "NRM_TWILIO_AUTH_TOKEN"

MAX_MEDIA_ITEMS = 4
MAX_MEDIA_BYTES = 5 * 1024 * 1024
MAX_TOTAL_MEDIA_BYTES = 10 * 1024 * 1024
DOWNLOAD_TIMEOUT_SECONDS = 30.0

ALLOWED_MEDIA_TYPES = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
}
TWILIO_MEDIA_PATH = re.compile(
    r"^/2010-04-01/Accounts/(?P<account>AC[0-9a-fA-F]{32})/"
    r"Messages/(?:SM|MM)[0-9a-fA-F]{32}/Media/ME[0-9a-fA-F]{32}$"
)


class MediaError(RuntimeError):
    """A safe, categorized media-processing failure."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class DownloadedMedia:
    source_url: str
    content_type: str
    path: Path
    size_bytes: int


@contextmanager
def temporary_twilio_media(
    media_urls: Sequence[str],
    *,
    client: httpx.Client | None = None,
    temp_root: Path | None = None,
) -> Iterator[list[DownloadedMedia]]:
    """Download validated Twilio images and always remove their scoped directory."""

    if not media_urls:
        yield []
        return
    if len(media_urls) > MAX_MEDIA_ITEMS:
        raise MediaError(
            "MEDIA_LIMIT_EXCEEDED",
            f"At most {MAX_MEDIA_ITEMS} images may be processed per request.",
        )

    account_sid = _required_secret(TWILIO_ACCOUNT_SID_ENV)
    auth_token = _required_secret(TWILIO_AUTH_TOKEN_ENV)
    auth = httpx.BasicAuth(account_sid, auth_token)
    own_client = client is None
    active_client = client or httpx.Client(
        timeout=httpx.Timeout(DOWNLOAD_TIMEOUT_SECONDS, connect=10.0),
        follow_redirects=False,
    )
    temp_directory = Path(
        tempfile.mkdtemp(
            prefix="nrm-media-",
            dir=str(temp_root) if temp_root is not None else None,
        )
    )

    try:
        downloaded: list[DownloadedMedia] = []
        total_bytes = 0
        for index, media_url in enumerate(media_urls):
            _validate_twilio_media_url(media_url, expected_account_sid=account_sid)
            item = _download_one(
                active_client,
                media_url,
                auth=auth,
                destination_directory=temp_directory,
                index=index,
                remaining_total_bytes=MAX_TOTAL_MEDIA_BYTES - total_bytes,
            )
            downloaded.append(item)
            total_bytes += item.size_bytes
        yield downloaded
    finally:
        try:
            if temp_directory.exists():
                try:
                    shutil.rmtree(temp_directory)
                except OSError as error:
                    raise MediaError(
                        "MEDIA_CLEANUP_FAILED",
                        "Temporary media could not be removed from local disk.",
                    ) from error
        finally:
            if own_client:
                active_client.close()


def _download_one(
    client: httpx.Client,
    media_url: str,
    *,
    auth: httpx.BasicAuth,
    destination_directory: Path,
    index: int,
    remaining_total_bytes: int,
) -> DownloadedMedia:
    try:
        with client.stream("GET", media_url, auth=auth) as response:
            if response.is_redirect:
                raise MediaError(
                    "MEDIA_DOWNLOAD_FAILED",
                    "Twilio media redirects are not accepted.",
                )
            response.raise_for_status()
            content_type = _normalized_content_type(response.headers.get("content-type"))
            if content_type not in ALLOWED_MEDIA_TYPES:
                raise MediaError(
                    "MEDIA_TYPE_NOT_ALLOWED",
                    "Only JPEG, PNG, and WebP images are accepted.",
                )

            declared_length = _content_length(response.headers.get("content-length"))
            effective_limit = min(MAX_MEDIA_BYTES, remaining_total_bytes)
            if declared_length is not None and declared_length > effective_limit:
                raise MediaError(
                    "MEDIA_TOO_LARGE",
                    "Downloaded media exceeds the configured size limit.",
                )

            destination = destination_directory / (
                f"media-{index}{ALLOWED_MEDIA_TYPES[content_type]}"
            )
            size_bytes = 0
            with destination.open("xb") as media_file:
                for chunk in response.iter_bytes():
                    size_bytes += len(chunk)
                    if size_bytes > effective_limit:
                        raise MediaError(
                            "MEDIA_TOO_LARGE",
                            "Downloaded media exceeds the configured size limit.",
                        )
                    media_file.write(chunk)
    except MediaError:
        raise
    except (httpx.RequestError, httpx.HTTPStatusError, OSError) as error:
        raise MediaError(
            "MEDIA_DOWNLOAD_FAILED",
            "Twilio media could not be downloaded securely.",
        ) from error

    if size_bytes == 0:
        raise MediaError("MEDIA_DOWNLOAD_FAILED", "Twilio media was empty.")
    if not _matches_image_signature(destination, content_type):
        raise MediaError(
            "MEDIA_TYPE_NOT_ALLOWED",
            "Downloaded media bytes do not match the declared image type.",
        )
    return DownloadedMedia(
        source_url=media_url,
        content_type=content_type,
        path=destination,
        size_bytes=size_bytes,
    )


def _required_secret(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise MediaError(
            "MEDIA_CONFIG_ERROR",
            f"Required local media credential is missing: {name}.",
        )
    return value


def _validate_twilio_media_url(
    media_url: str,
    *,
    expected_account_sid: str,
) -> None:
    try:
        parsed = urlsplit(media_url)
        port = parsed.port
    except (TypeError, ValueError) as error:
        raise MediaError("INVALID_MEDIA_URL", "Twilio media URL is invalid.") from error
    path_match = TWILIO_MEDIA_PATH.fullmatch(parsed.path)
    if (
        parsed.scheme.lower() != "https"
        or (parsed.hostname or "").lower() != "api.twilio.com"
        or port not in (None, 443)
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or path_match is None
        or path_match.group("account") != expected_account_sid
    ):
        raise MediaError(
            "INVALID_MEDIA_URL",
            "Media URL must be an HTTPS Twilio API media resource.",
        )


def _normalized_content_type(raw_value: str | None) -> str:
    return (raw_value or "").split(";", 1)[0].strip().lower()


def _content_length(raw_value: str | None) -> int | None:
    if raw_value is None:
        return None
    try:
        value = int(raw_value)
    except ValueError as error:
        raise MediaError(
            "MEDIA_DOWNLOAD_FAILED",
            "Twilio media returned an invalid Content-Length header.",
        ) from error
    if value < 0:
        raise MediaError(
            "MEDIA_DOWNLOAD_FAILED",
            "Twilio media returned an invalid Content-Length header.",
        )
    return value


def _matches_image_signature(path: Path, content_type: str) -> bool:
    with path.open("rb") as media_file:
        header = media_file.read(16)
    if content_type == "image/jpeg":
        return header.startswith(b"\xff\xd8\xff")
    if content_type == "image/png":
        return header.startswith(b"\x89PNG\r\n\x1a\n")
    if content_type == "image/webp":
        return len(header) >= 12 and header[:4] == b"RIFF" and header[8:12] == b"WEBP"
    return False
