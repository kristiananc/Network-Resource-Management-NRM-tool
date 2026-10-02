#!/usr/bin/env python3
"""Print mocked Stage 7 drafts and temporary-media lifecycle evidence."""

from __future__ import annotations

import json
import os
import sys
import tempfile
from datetime import date
from io import BytesIO
from pathlib import Path
from typing import Any
from unittest.mock import patch

import httpx
from PIL import Image, ImageDraw

from app.inference import InferenceError, process_interaction
from app.models import ProcessInteractionRequest


MEDIA_URL = (
    "https://api.twilio.com/2010-04-01/Accounts/AC00000000000000000000000000000000/"
    "Messages/MM11111111111111111111111111111111/"
    "Media/ME22222222222222222222222222222222"
)
MEDIA_ENV = {
    "NRM_TWILIO_ACCOUNT_SID": "AC00000000000000000000000000000000",
    "NRM_TWILIO_AUTH_TOKEN": "local-test-auth-token",
    "NRM_OLLAMA_VISION_MODEL": "qwen2.5vl:3b",
}


def synthetic_png() -> bytes:
    image = Image.new("RGB", (640, 480), "white")
    drawing = ImageDraw.Draw(image)
    drawing.text((24, 24), "BUSINESS CARD Sarah Chen NAVWAR", fill="black")
    output = BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


PNG_BYTES = synthetic_png()


def mock_client(*, oversized: bool = False) -> httpx.Client:
    headers = {"content-type": "image/png"}
    if oversized:
        headers["content-length"] = str(5 * 1024 * 1024 + 1)
    return httpx.Client(
        transport=httpx.MockTransport(
            lambda _request: httpx.Response(200, headers=headers, content=PNG_BYTES)
        )
    )


def output_json(
    *,
    name: str | None,
    organization: str | None,
    summary: str | None,
    evidence: list[str],
    warnings: list[str] | None = None,
    interaction_date: str | None = "2026-10-01",
    platform: str | None = "IN_PERSON",
) -> str:
    return json.dumps(
        {
            "schema_version": "1.0",
            "person": {
                "name": name,
                "phone": None,
                "email": None,
                "organization": organization,
                "context_tag": None,
            },
            "interaction": {
                "date": interaction_date,
                "platform": platform,
                "summary": summary,
            },
            "identity": {"confidence": 0.9, "evidence": evidence},
            "warnings": warnings or [],
        }
    )


def snapshot(root: Path) -> list[str]:
    result = []
    for path in sorted(root.rglob("*")):
        relative_parts = path.relative_to(root).parts
        normalized = Path("<scoped-temp>", *relative_parts[1:])
        result.append(str(normalized) + ("/" if path.is_dir() else ""))
    return result


def run_success_case(
    *,
    case_id: str,
    caption: str,
    response: str,
    expected_name: str,
) -> bool:
    client = mock_client()
    with tempfile.TemporaryDirectory() as root_name, patch.dict(
        os.environ, MEDIA_ENV, clear=False
    ):
        root = Path(root_name)
        before = snapshot(root)
        during: list[str] = []

        def vision_chat(_messages, _schema):
            during.extend(snapshot(root))
            return response

        draft = process_interaction(
            ProcessInteractionRequest(
                owner_id="own_stage7_regression",
                review_id=f"review_{case_id}",
                raw_body=caption,
                media_refs=[MEDIA_URL],
            ),
            current_date=date(2026, 10, 1),
            vision_chat=vision_chat,
            media_client=client,
            media_temp_root=root,
        )
        after = snapshot(root)
    client.close()

    actual_name = draft.details_json["person"]["name"]
    passed = (
        actual_name == expected_name
        and draft.schema_version == "1.0"
        and before == []
        and any(item.endswith("media-0.png") for item in during)
        and after == []
    )
    print(f"CASE: {case_id}")
    print("INPUT:")
    print(json.dumps({"caption": caption, "media_refs": [MEDIA_URL]}, indent=2))
    print("DRAFT:")
    print(json.dumps(draft.model_dump(mode="json"), indent=2, sort_keys=True))
    print(f"TEMP_BEFORE: {json.dumps(before)}")
    print(f"TEMP_DURING: {json.dumps(during)}")
    print(f"TEMP_AFTER: {json.dumps(after)}")
    print(f"RESULT: {'PASS' if passed else 'FAIL'}")
    return passed


def run_failure_cleanup_case() -> bool:
    client = mock_client()
    with tempfile.TemporaryDirectory() as root_name, patch.dict(
        os.environ, MEDIA_ENV, clear=False
    ):
        root = Path(root_name)
        before = snapshot(root)
        during: list[str] = []

        def failing_vision_chat(_messages, _schema):
            during.extend(snapshot(root))
            raise InferenceError("LOCAL_API_UNAVAILABLE", "Synthetic VLM failure.")

        error_code = None
        try:
            process_interaction(
                ProcessInteractionRequest(
                    owner_id="own_stage7_regression",
                    review_id="review_inference_failure_cleanup",
                    raw_body="",
                    media_refs=[MEDIA_URL],
                ),
                vision_chat=failing_vision_chat,
                media_client=client,
                media_temp_root=root,
            )
        except InferenceError as error:
            error_code = error.code
        after = snapshot(root)
    client.close()

    passed = (
        error_code == "LOCAL_API_UNAVAILABLE"
        and before == []
        and any(item.endswith("media-0.png") for item in during)
        and after == []
    )
    print("CASE: inference_failure_cleanup")
    print(f"ERROR_CODE: {error_code}")
    print(f"TEMP_BEFORE: {json.dumps(before)}")
    print(f"TEMP_DURING: {json.dumps(during)}")
    print(f"TEMP_AFTER: {json.dumps(after)}")
    print(f"RESULT: {'PASS' if passed else 'FAIL'}")
    return passed


def main() -> int:
    cases: list[bool] = []
    cases.append(
        run_success_case(
            case_id="image_only_business_card",
            caption="",
            response=output_json(
                name="Sarah Chen",
                organization="NAVWAR",
                summary=None,
                evidence=["name and organization supplied by image"],
                warnings=["No interaction context was supplied."],
                interaction_date=None,
                platform=None,
            ),
            expected_name="Sarah Chen",
        )
    )
    cases.append(
        run_success_case(
            case_id="caption_and_image_agree",
            caption=(
                "Met Sarah Chen from NAVWAR in person today and discussed a "
                "maritime autonomy project."
            ),
            response=output_json(
                name="Sarah Chen",
                organization="NAVWAR",
                summary="Discussed a maritime autonomy project.",
                evidence=["caption and business card agree on identity"],
            ),
            expected_name="Sarah Chen",
        )
    )
    cases.append(
        run_success_case(
            case_id="caption_overrides_image_name",
            caption=(
                "The correct name is Sara Chen, not Sarah Chen. We discussed a "
                "maritime autonomy project."
            ),
            response=output_json(
                name="Sara Chen",
                organization="NAVWAR",
                summary="Discussed a maritime autonomy project.",
                evidence=["caption corrected the name visible in the image"],
                interaction_date=None,
                platform=None,
            ),
            expected_name="Sara Chen",
        )
    )
    cases.append(run_failure_cleanup_case())
    passed = sum(cases)
    print(f"SUMMARY: {passed}/{len(cases)} passed")
    return 0 if passed == len(cases) else 1


if __name__ == "__main__":
    sys.exit(main())
