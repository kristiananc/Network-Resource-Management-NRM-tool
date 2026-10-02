"""Stage 7 mocked VLM routing, caption-priority, and cleanup tests."""

import base64
import json
import math
import os
import tempfile
import unittest
from datetime import date
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

import httpx
from PIL import Image, ImageDraw

from app.inference import InferenceError, process_interaction
from app.models import ProcessInteractionRequest
from app.vision import VISION_MAX_LONG_EDGE, VISION_MAX_PIXELS, estimate_visual_tokens


MEDIA_URL = (
    "https://api.twilio.com/2010-04-01/Accounts/AC00000000000000000000000000000000/"
    "Messages/MM11111111111111111111111111111111/"
    "Media/ME22222222222222222222222222222222"
)
IMAGE_NAME = "Sarah Chen"
MEDIA_ENV = {
    "NRM_TWILIO_ACCOUNT_SID": "AC00000000000000000000000000000000",
    "NRM_TWILIO_AUTH_TOKEN": "local-test-auth-token",
    "NRM_OLLAMA_VISION_MODEL": "qwen2.5vl:3b",
    "NRM_OLLAMA_VISION_NUM_CTX": "8192",
}


def rendered_image_bytes(
    label: str = "BUSINESS CARD Sarah Chen NAVWAR",
    *,
    size: tuple[int, int] = (640, 480),
    image_format: str = "PNG",
    quality: int = 95,
) -> bytes:
    image = Image.new("RGB", size, "white")
    drawing = ImageDraw.Draw(image)
    for y in range(20, size[1], 40):
        drawing.line((0, y, size[0], y), fill=(220, 225, 230), width=2)
    drawing.text((24, 24), label, fill="black")
    output = BytesIO()
    save_options = {"quality": quality} if image_format == "JPEG" else {}
    image.save(output, format=image_format, **save_options)
    return output.getvalue()


PNG_BYTES = rendered_image_bytes()


def media_client(
    content: bytes = PNG_BYTES,
    *,
    content_type: str = "image/png",
) -> httpx.Client:
    return httpx.Client(
        transport=httpx.MockTransport(
            lambda _request: httpx.Response(
                200,
                headers={"content-type": content_type},
                content=content,
            )
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
    confidence: float = 0.9,
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
            "identity": {"confidence": confidence, "evidence": evidence},
            "warnings": warnings or [],
        }
    )


class Stage7VisionTests(unittest.TestCase):
    def test_image_only_routes_to_vlm_and_returns_schema_v1_draft(self) -> None:
        client = media_client()
        calls = []

        def vision_chat(messages, schema):
            calls.append(messages)
            self.assertEqual(schema["properties"]["schema_version"]["const"], "1.0")
            self.assertNotIn("own_image_only", json.dumps(messages))
            self.assertIn("No user caption was provided", messages[2]["content"])
            self.assertEqual(len(messages[2]["images"]), 1)
            return output_json(
                name="Sarah Chen",
                organization="NAVWAR",
                summary=None,
                evidence=["name and organization supplied by image"],
                warnings=["No interaction context was supplied."],
                interaction_date=None,
                platform=None,
            )

        with tempfile.TemporaryDirectory() as root_name, patch.dict(
            os.environ, MEDIA_ENV, clear=False
        ):
            draft = process_interaction(
                ProcessInteractionRequest(
                    owner_id="own_image_only",
                    review_id="review_image_only",
                    raw_body="",
                    media_refs=[MEDIA_URL],
                ),
                current_date=date(2026, 10, 1),
                chat=lambda *_args: self.fail("text model must not be called"),
                vision_chat=vision_chat,
                media_client=client,
                media_temp_root=Path(root_name),
            )
            self.assertEqual(list(Path(root_name).iterdir()), [])
        client.close()

        self.assertEqual(len(calls), 1)
        self.assertEqual(draft.schema_version, "1.0")
        self.assertEqual(draft.details_json["person"]["name"], "Sarah Chen")
        self.assertEqual(draft.ai_model, "qwen2.5vl:3b")

    def test_text_and_image_agree(self) -> None:
        client = media_client()

        def vision_chat(messages, _schema):
            self.assertIn("Sarah Chen from NAVWAR", messages[2]["content"])
            image_bytes = base64.b64decode(messages[2]["images"][0])
            with Image.open(BytesIO(image_bytes)) as image:
                self.assertEqual(image.format, "JPEG")
                self.assertEqual(image.size, (640, 480))
            return output_json(
                name="Sarah Chen",
                organization="NAVWAR",
                summary="Discussed a maritime autonomy project.",
                evidence=["caption and business card agree on identity"],
            )

        with tempfile.TemporaryDirectory() as root_name, patch.dict(
            os.environ, MEDIA_ENV, clear=False
        ):
            draft = process_interaction(
                ProcessInteractionRequest(
                    owner_id="own_agree",
                    review_id="review_agree",
                    raw_body=(
                        "Met Sarah Chen from NAVWAR in person today and discussed "
                        "a maritime autonomy project."
                    ),
                    media_refs=[MEDIA_URL],
                ),
                current_date=date(2026, 10, 1),
                vision_chat=vision_chat,
                media_client=client,
                media_temp_root=Path(root_name),
            )
        client.close()

        self.assertEqual(draft.details_json["person"]["name"], "Sarah Chen")
        self.assertEqual(draft.details_json["person"]["organization"], "NAVWAR")
        self.assertEqual(draft.summary, "Discussed a maritime autonomy project.")

    def test_caption_correction_wins_over_conflicting_image_text(self) -> None:
        client = media_client()

        def vision_chat(messages, _schema):
            self.assertIn("higher priority than image evidence", messages[2]["content"])
            self.assertIn("Sara Chen, not Sarah Chen", messages[2]["content"])
            image_bytes = base64.b64decode(messages[2]["images"][0])
            with Image.open(BytesIO(image_bytes)) as image:
                self.assertEqual(image.format, "JPEG")
            self.assertIn(
                "caption or instruction is the authoritative semantic guide",
                messages[0]["content"],
            )
            return output_json(
                name="Sara Chen",
                organization="NAVWAR",
                summary="Discussed a maritime autonomy project.",
                evidence=["caption corrected the name visible in the image"],
                interaction_date=None,
                platform=None,
            )

        with tempfile.TemporaryDirectory() as root_name, patch.dict(
            os.environ, MEDIA_ENV, clear=False
        ):
            draft = process_interaction(
                ProcessInteractionRequest(
                    owner_id="own_conflict",
                    review_id="review_conflict",
                    raw_body=(
                        "The correct name is Sara Chen, not Sarah Chen. We "
                        "discussed a maritime autonomy project."
                    ),
                    media_refs=[MEDIA_URL],
                ),
                current_date=date(2026, 10, 1),
                vision_chat=vision_chat,
                media_client=client,
                media_temp_root=Path(root_name),
            )
        client.close()

        self.assertEqual(draft.details_json["person"]["name"], "Sara Chen")
        self.assertNotEqual(draft.details_json["person"]["name"], IMAGE_NAME)

    def test_event_screenshot_produces_supported_event_draft(self) -> None:
        client = media_client(
            rendered_image_bytes("EVENT Defense Tech Summit DATE 2026-10-20")
        )

        def vision_chat(messages, _schema):
            image_bytes = base64.b64decode(messages[2]["images"][0])
            with Image.open(BytesIO(image_bytes)) as image:
                self.assertEqual(image.format, "JPEG")
            return output_json(
                name=None,
                organization=None,
                summary="Met event organizers at the Defense Tech Summit.",
                evidence=["event name and date supplied by screenshot"],
                interaction_date="2026-10-20",
                platform="EVENT",
            )

        with tempfile.TemporaryDirectory() as root_name, patch.dict(
            os.environ, MEDIA_ENV, clear=False
        ):
            draft = process_interaction(
                ProcessInteractionRequest(
                    owner_id="own_event_screenshot",
                    review_id="review_event_screenshot",
                    raw_body="I met the organizers at this event.",
                    media_refs=[MEDIA_URL],
                ),
                current_date=date(2026, 10, 1),
                vision_chat=vision_chat,
                media_client=client,
                media_temp_root=Path(root_name),
            )
        client.close()

        self.assertEqual(draft.platform.value, "EVENT")
        self.assertEqual(draft.interaction_date, date(2026, 10, 20))
        self.assertIn("Defense Tech Summit", draft.summary)

    def test_representative_photo_does_not_fabricate_identity(self) -> None:
        client = media_client(rendered_image_bytes("PHOTO WITH NO READABLE TEXT"))

        def vision_chat(_messages, _schema):
            return output_json(
                name=None,
                organization=None,
                summary=None,
                evidence=[],
                warnings=["The photo contains no reliable identity or interaction text."],
                interaction_date=None,
                platform=None,
                confidence=0.0,
            )

        with tempfile.TemporaryDirectory() as root_name, patch.dict(
            os.environ, MEDIA_ENV, clear=False
        ):
            draft = process_interaction(
                ProcessInteractionRequest(
                    owner_id="own_photo",
                    review_id="review_photo",
                    raw_body="",
                    media_refs=[MEDIA_URL],
                ),
                current_date=date(2026, 10, 1),
                vision_chat=vision_chat,
                media_client=client,
                media_temp_root=Path(root_name),
            )
        client.close()

        self.assertIsNone(draft.details_json["person"]["name"])
        self.assertIsNone(draft.summary)
        self.assertEqual(draft.details_json["identity"]["confidence"], 0.0)
        self.assertTrue(draft.details_json["warnings"])

    def test_large_image_is_bounded_and_vision_num_ctx_is_sent(self) -> None:
        before_dimensions = (4032, 3024)
        original_bytes = rendered_image_bytes(
            "BUSINESS CARD OCR REGRESSION " * 8,
            size=before_dimensions,
            image_format="JPEG",
            quality=95,
        )
        client = media_client(original_bytes, content_type="image/jpeg")
        captured_payload: dict = {}

        def ollama_handler(request: httpx.Request) -> httpx.Response:
            captured_payload.update(json.loads(request.content))
            return httpx.Response(
                200,
                json={
                    "message": {
                        "content": output_json(
                            name="Sarah Chen",
                            organization="NAVWAR",
                            summary=None,
                            evidence=["business card image"],
                            interaction_date=None,
                            platform=None,
                        )
                    }
                },
            )

        ollama_client = httpx.Client(transport=httpx.MockTransport(ollama_handler))
        with tempfile.TemporaryDirectory() as root_name, patch.dict(
            os.environ, MEDIA_ENV, clear=False
        ), patch("app.inference.httpx.Client", return_value=ollama_client):
            process_interaction(
                ProcessInteractionRequest(
                    owner_id="own_large_image",
                    review_id="review_large_image",
                    media_refs=[MEDIA_URL],
                ),
                current_date=date(2026, 10, 1),
                media_client=client,
                media_temp_root=Path(root_name),
            )
        client.close()

        prepared_bytes = base64.b64decode(
            captured_payload["messages"][2]["images"][0]
        )
        with Image.open(BytesIO(prepared_bytes)) as prepared_image:
            after_dimensions = prepared_image.size
            prepared_format = prepared_image.format

        scrubbed_messages = [
            {key: value for key, value in message.items() if key != "images"}
            for message in captured_payload["messages"]
        ]
        text_and_schema_chars = len(
            json.dumps(
                {
                    "messages": scrubbed_messages,
                    "format": captured_payload["format"],
                },
                separators=(",", ":"),
            )
        )
        estimated_prompt_tokens = (
            math.ceil(text_and_schema_chars / 3)
            + estimate_visual_tokens(*after_dimensions)
        )
        configured_num_ctx = captured_payload["options"]["num_ctx"]

        self.assertEqual(prepared_format, "JPEG")
        self.assertLessEqual(max(after_dimensions), VISION_MAX_LONG_EDGE)
        self.assertLessEqual(after_dimensions[0] * after_dimensions[1], VISION_MAX_PIXELS)
        self.assertLess(len(prepared_bytes), len(original_bytes))
        self.assertEqual(configured_num_ctx, 8192)
        self.assertLess(estimated_prompt_tokens + 1024, configured_num_ctx)
        print(
            "VISION_PREPROCESS_EVIDENCE "
            f"before_dimensions={before_dimensions[0]}x{before_dimensions[1]} "
            f"after_dimensions={after_dimensions[0]}x{after_dimensions[1]} "
            f"before_bytes={len(original_bytes)} "
            f"after_bytes={len(prepared_bytes)} "
            f"estimated_prompt_tokens={estimated_prompt_tokens} "
            f"response_reserve=1024 num_ctx={configured_num_ctx}"
        )

    def test_downloaded_media_is_deleted_after_successful_inference(self) -> None:
        client = media_client()
        observed_during = []
        with tempfile.TemporaryDirectory() as root_name, patch.dict(
            os.environ, MEDIA_ENV, clear=False
        ):
            root = Path(root_name)

            def vision_chat(_messages, _schema):
                observed_during.extend(path for path in root.rglob("*") if path.is_file())
                self.assertEqual(len(observed_during), 1)
                self.assertTrue(observed_during[0].exists())
                return output_json(
                    name="Sarah Chen",
                    organization="NAVWAR",
                    summary=None,
                    evidence=["image evidence"],
                )

            process_interaction(
                ProcessInteractionRequest(
                    owner_id="own_cleanup_success",
                    review_id="review_cleanup_success",
                    media_refs=[MEDIA_URL],
                ),
                vision_chat=vision_chat,
                media_client=client,
                media_temp_root=root,
            )
            self.assertTrue(observed_during)
            self.assertFalse(observed_during[0].exists())
            self.assertEqual(list(root.iterdir()), [])
        client.close()

    def test_downloaded_media_is_deleted_when_inference_fails(self) -> None:
        client = media_client()
        observed_during = []
        with tempfile.TemporaryDirectory() as root_name, patch.dict(
            os.environ, MEDIA_ENV, clear=False
        ):
            root = Path(root_name)

            def failing_vision_chat(_messages, _schema):
                observed_during.extend(path for path in root.rglob("*") if path.is_file())
                self.assertEqual(len(observed_during), 1)
                self.assertTrue(observed_during[0].exists())
                raise InferenceError(
                    "LOCAL_API_UNAVAILABLE", "Synthetic VLM failure."
                )

            with self.assertRaises(InferenceError) as captured:
                process_interaction(
                    ProcessInteractionRequest(
                        owner_id="own_cleanup_failure",
                        review_id="review_cleanup_failure",
                        media_refs=[MEDIA_URL],
                    ),
                    vision_chat=failing_vision_chat,
                    media_client=client,
                    media_temp_root=root,
                )
            self.assertEqual(captured.exception.code, "LOCAL_API_UNAVAILABLE")
            self.assertTrue(observed_during)
            self.assertFalse(observed_during[0].exists())
            self.assertEqual(list(root.iterdir()), [])
        client.close()

    def test_text_only_capture_never_calls_media_or_vision_path(self) -> None:
        def text_chat(messages, _schema):
            self.assertIn("Input mode is text-only", messages[1]["content"])
            return output_json(
                name="Jordan Lee",
                organization=None,
                summary="Discussed a project update.",
                evidence=["name supplied by text"],
                interaction_date=None,
                platform="CALL",
            )

        draft = process_interaction(
            ProcessInteractionRequest(
                owner_id="own_text_unchanged",
                review_id="review_text_unchanged",
                raw_body="Called Jordan about a project update.",
                media_refs=[],
            ),
            current_date=date(2026, 10, 1),
            chat=text_chat,
            vision_chat=lambda *_args: self.fail("vision model must not be called"),
        )

        self.assertEqual(draft.details_json["person"]["name"], "Jordan Lee")
        self.assertEqual(draft.ai_model, "llama3.1:8b")


if __name__ == "__main__":
    unittest.main()
