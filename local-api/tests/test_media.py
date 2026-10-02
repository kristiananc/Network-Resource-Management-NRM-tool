"""Stage 7 authenticated-download limits and cleanup tests."""

import base64
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx

from app.media import (
    MAX_MEDIA_ITEMS,
    MAX_MEDIA_BYTES,
    MAX_TOTAL_MEDIA_BYTES,
    MediaError,
    _validate_twilio_media_url,
    temporary_twilio_media,
)


MEDIA_URL = (
    "https://api.twilio.com/2010-04-01/Accounts/AC00000000000000000000000000000000/"
    "Messages/MM11111111111111111111111111111111/"
    "Media/ME22222222222222222222222222222222"
)
PNG_BYTES = b"\x89PNG\r\n\x1a\nsynthetic-stage7-image"
MEDIA_ENV = {
    "NRM_TWILIO_ACCOUNT_SID": "AC00000000000000000000000000000000",
    "NRM_TWILIO_AUTH_TOKEN": "local-test-auth-token",
}


class Stage7MediaTests(unittest.TestCase):
    def test_production_shape_twilio_media_url_passes_validation(self) -> None:
        media_url = (
            "https://api.twilio.com/2010-04-01/Accounts/"
            "AC00000000000000000000000000000000/"
            "Messages/MM11111111111111111111111111111111/"
            "Media/ME22222222222222222222222222222222"
        )
        _validate_twilio_media_url(
            media_url,
            expected_account_sid="AC00000000000000000000000000000000",
        )

    def test_production_shape_url_and_reported_jpeg_size_download_successfully(self) -> None:
        media_url = (
            "https://api.twilio.com/2010-04-01/Accounts/"
            "AC00000000000000000000000000000000/"
            "Messages/MM11111111111111111111111111111111/"
            "Media/ME22222222222222222222222222222222"
        )
        jpeg_bytes = b"\xff\xd8\xff" + b"x" * (742786 - 3)
        client = httpx.Client(
            transport=httpx.MockTransport(
                lambda _request: httpx.Response(
                    200,
                    headers={"content-type": "image/jpeg"},
                    content=jpeg_bytes,
                )
            )
        )
        environment = {
            "NRM_TWILIO_ACCOUNT_SID": "AC00000000000000000000000000000000",
            "NRM_TWILIO_AUTH_TOKEN": "local-test-auth-token",
        }
        with tempfile.TemporaryDirectory() as root_name, patch.dict(
            os.environ, environment, clear=False
        ):
            root = Path(root_name)
            with temporary_twilio_media(
                [media_url], client=client, temp_root=root
            ) as downloaded:
                self.assertEqual(downloaded[0].content_type, "image/jpeg")
                self.assertEqual(downloaded[0].size_bytes, 742786)
                self.assertTrue(downloaded[0].path.exists())
            self.assertEqual(list(root.iterdir()), [])
        client.close()

    def test_temp_directory_permission_failure_is_categorized(self) -> None:
        client = httpx.Client(
            transport=httpx.MockTransport(
                lambda _request: self.fail("storage failure must happen first")
            )
        )
        with patch.dict(os.environ, MEDIA_ENV, clear=False), patch(
            "app.media.tempfile.mkdtemp",
            side_effect=PermissionError("service account cannot write temp directory"),
        ):
            with self.assertRaises(MediaError) as captured:
                with temporary_twilio_media([MEDIA_URL], client=client):
                    self.fail("storage failure must not yield media")
        self.assertEqual(captured.exception.code, "MEDIA_STORAGE_FAILED")
        self.assertEqual(captured.exception.stage, "media_storage")
        self.assertIn("PermissionError", captured.exception.diagnostic)
        client.close()

    def test_authenticated_download_exists_only_inside_context(self) -> None:
        expected_auth = "Basic " + base64.b64encode(
            b"AC00000000000000000000000000000000:local-test-auth-token"
        ).decode("ascii")

        def handler(request: httpx.Request) -> httpx.Response:
            self.assertEqual(request.headers["authorization"], expected_auth)
            return httpx.Response(
                200,
                headers={"content-type": "image/png"},
                content=PNG_BYTES,
            )

        client = httpx.Client(transport=httpx.MockTransport(handler))
        with tempfile.TemporaryDirectory() as root_name, patch.dict(
            os.environ, MEDIA_ENV, clear=False
        ):
            root = Path(root_name)
            self.assertEqual(list(root.iterdir()), [])
            with temporary_twilio_media(
                [MEDIA_URL], client=client, temp_root=root
            ) as downloaded:
                self.assertEqual(len(downloaded), 1)
                self.assertTrue(downloaded[0].path.exists())
                self.assertEqual(downloaded[0].path.read_bytes(), PNG_BYTES)
                self.assertEqual(len(list(root.iterdir())), 1)
            self.assertEqual(list(root.iterdir()), [])
        client.close()

    def test_partial_download_failure_removes_scoped_directory(self) -> None:
        calls = 0

        def handler(_request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            if calls == 1:
                return httpx.Response(
                    200,
                    headers={"content-type": "image/png"},
                    content=PNG_BYTES,
                )
            return httpx.Response(500)

        client = httpx.Client(transport=httpx.MockTransport(handler))
        with tempfile.TemporaryDirectory() as root_name, patch.dict(
            os.environ, MEDIA_ENV, clear=False
        ):
            root = Path(root_name)
            with self.assertRaises(MediaError) as captured:
                with temporary_twilio_media(
                    [MEDIA_URL, MEDIA_URL], client=client, temp_root=root
                ):
                    self.fail("download failure must occur before yielding")
            self.assertEqual(captured.exception.code, "MEDIA_DOWNLOAD_FAILED")
            self.assertEqual(list(root.iterdir()), [])
        client.close()

    def test_oversized_media_is_rejected_and_removed(self) -> None:
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                headers={
                    "content-type": "image/png",
                    "content-length": str(MAX_MEDIA_BYTES + 1),
                },
                content=PNG_BYTES,
            )

        client = httpx.Client(transport=httpx.MockTransport(handler))
        with tempfile.TemporaryDirectory() as root_name, patch.dict(
            os.environ, MEDIA_ENV, clear=False
        ):
            root = Path(root_name)
            with self.assertRaises(MediaError) as captured:
                with temporary_twilio_media(
                    [MEDIA_URL], client=client, temp_root=root
                ):
                    self.fail("oversized media must not be yielded")
            self.assertEqual(captured.exception.code, "MEDIA_TOO_LARGE")
            self.assertEqual(list(root.iterdir()), [])
        client.close()

    def test_disallowed_or_spoofed_media_type_is_rejected_and_removed(self) -> None:
        cases = [
            ("text/plain", b"not an image"),
            ("image/png", b"not actually a PNG"),
        ]
        for content_type, content in cases:
            with self.subTest(content_type=content_type, content=content):
                client = httpx.Client(
                    transport=httpx.MockTransport(
                        lambda _request: httpx.Response(
                            200,
                            headers={"content-type": content_type},
                            content=content,
                        )
                    )
                )
                with tempfile.TemporaryDirectory() as root_name, patch.dict(
                    os.environ, MEDIA_ENV, clear=False
                ):
                    root = Path(root_name)
                    with self.assertRaises(MediaError) as captured:
                        with temporary_twilio_media(
                            [MEDIA_URL], client=client, temp_root=root
                        ):
                            self.fail("disallowed media must not be yielded")
                    self.assertEqual(captured.exception.code, "MEDIA_TYPE_NOT_ALLOWED")
                    self.assertEqual(list(root.iterdir()), [])
                client.close()

    def test_credentials_are_never_sent_to_a_non_twilio_host(self) -> None:
        requests = []
        client = httpx.Client(
            transport=httpx.MockTransport(
                lambda request: requests.append(request) or httpx.Response(200)
            )
        )
        with tempfile.TemporaryDirectory() as root_name, patch.dict(
            os.environ, MEDIA_ENV, clear=False
        ):
            root = Path(root_name)
            with self.assertRaises(MediaError) as captured:
                with temporary_twilio_media(
                    ["https://example.com/stolen-image.png"],
                    client=client,
                    temp_root=root,
                ):
                    self.fail("untrusted host must not be fetched")
            self.assertEqual(captured.exception.code, "INVALID_MEDIA_URL")
            self.assertEqual(requests, [])
            self.assertEqual(list(root.iterdir()), [])
        client.close()

    def test_media_count_limit_is_rejected_without_creating_files(self) -> None:
        client = httpx.Client(
            transport=httpx.MockTransport(
                lambda _request: self.fail("over-limit request must not download")
            )
        )
        with tempfile.TemporaryDirectory() as root_name, patch.dict(
            os.environ, MEDIA_ENV, clear=False
        ):
            root = Path(root_name)
            with self.assertRaises(MediaError) as captured:
                with temporary_twilio_media(
                    [MEDIA_URL] * (MAX_MEDIA_ITEMS + 1),
                    client=client,
                    temp_root=root,
                ):
                    self.fail("over-limit media must not be yielded")
            self.assertEqual(captured.exception.code, "MEDIA_LIMIT_EXCEEDED")
            self.assertEqual(list(root.iterdir()), [])
        client.close()

    def test_aggregate_size_limit_is_rejected_and_removed(self) -> None:
        item_size = (MAX_TOTAL_MEDIA_BYTES // 3) + 1
        content = b"\x89PNG\r\n\x1a\n" + b"x" * (item_size - 8)
        client = httpx.Client(
            transport=httpx.MockTransport(
                lambda _request: httpx.Response(
                    200,
                    headers={"content-type": "image/png"},
                    content=content,
                )
            )
        )
        with tempfile.TemporaryDirectory() as root_name, patch.dict(
            os.environ, MEDIA_ENV, clear=False
        ):
            root = Path(root_name)
            with self.assertRaises(MediaError) as captured:
                with temporary_twilio_media(
                    [MEDIA_URL, MEDIA_URL, MEDIA_URL],
                    client=client,
                    temp_root=root,
                ):
                    self.fail("aggregate-over-limit media must not be yielded")
            self.assertEqual(captured.exception.code, "MEDIA_TOO_LARGE")
            self.assertEqual(list(root.iterdir()), [])
        client.close()

    def test_missing_local_twilio_credentials_fail_before_download(self) -> None:
        requests = []
        client = httpx.Client(
            transport=httpx.MockTransport(
                lambda request: requests.append(request) or httpx.Response(200)
            )
        )
        with tempfile.TemporaryDirectory() as root_name, patch.dict(
            os.environ, {}, clear=True
        ):
            root = Path(root_name)
            with self.assertRaises(MediaError) as captured:
                with temporary_twilio_media(
                    [MEDIA_URL], client=client, temp_root=root
                ):
                    self.fail("missing credentials must not be yielded")
            self.assertEqual(captured.exception.code, "MEDIA_CONFIG_ERROR")
            self.assertEqual(requests, [])
            self.assertEqual(list(root.iterdir()), [])
        client.close()


if __name__ == "__main__":
    unittest.main()
