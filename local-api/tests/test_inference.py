"""Unit tests for Stage 6 prompt isolation, validation, repair, and outages."""

import json
import unittest
from datetime import date
from unittest.mock import patch

import httpx

from app.inference import (
    InferenceError,
    _ollama_chat,
    process_interaction,
    revise_draft,
)
from app.models import InteractionDraft, ProcessInteractionRequest, ReviseDraftRequest


def valid_output(**overrides):
    output = {
        "schema_version": "1.0",
        "person": {
            "name": "Maya Patel",
            "phone": None,
            "email": None,
            "organization": "Acme Robotics",
            "context_tag": "Robotics",
        },
        "interaction": {
            "date": "2026-09-23",
            "platform": "IN_PERSON",
            "summary": "Met Maya and discussed robotics partnerships.",
        },
        "identity": {
            "confidence": 0.9,
            "evidence": ["full name and organization supplied by text"],
        },
        "warnings": [],
    }
    output.update(overrides)
    return output


class Stage6InferenceTests(unittest.TestCase):
    def test_prompt_hierarchy_excludes_owner_metadata(self) -> None:
        captured = {}

        def chat(messages, schema):
            captured["messages"] = messages
            captured["schema"] = schema
            return json.dumps(valid_output())

        request = ProcessInteractionRequest(
            owner_id="own_secret_tenant_value",
            review_id="review-prompt-isolation",
            raw_body="Met Maya Patel from Acme Robotics today.",
            media_refs=[],
        )
        draft = process_interaction(
            request,
            current_date=date(2026, 9, 23),
            chat=chat,
        )

        serialized_prompt = json.dumps(captured["messages"])
        system_prompt = captured["messages"][0]["content"]
        self.assertNotIn(request.owner_id, serialized_prompt)
        self.assertNotIn("owner_id", serialized_prompt)
        self.assertIn("current_date=2026-09-23", serialized_prompt)
        self.assertIn("coffee, lunch, dinner", serialized_prompt)
        self.assertIn("video call, Zoom", serialized_prompt)
        self.assertIn("alone does not identify a", serialized_prompt)
        self.assertIn('"today" is exactly current_date', system_prompt)
        self.assertIn('"sometime last week"', system_prompt)
        self.assertIn("Do not repeat", serialized_prompt)
        self.assertEqual([item["role"] for item in captured["messages"]], ["system", "system", "user"])
        self.assertEqual(captured["messages"][-1]["content"], request.raw_body)
        self.assertIn("$defs", captured["schema"])
        self.assertEqual(draft.details_json["person"]["name"], "Maya Patel")

    def test_repairs_malformed_json_once(self) -> None:
        outputs = iter(["not-json", json.dumps(valid_output())])
        calls = []

        def chat(messages, _schema):
            calls.append(messages)
            return next(outputs)

        draft = process_interaction(
            ProcessInteractionRequest(
                owner_id="own_repair",
                review_id="review-repair",
                raw_body="Met Maya today.",
            ),
            current_date=date(2026, 9, 23),
            chat=chat,
        )
        self.assertEqual(len(calls), 2)
        self.assertIn("AI_INVALID_JSON", calls[1][-1]["content"])
        self.assertEqual(draft.summary, "Met Maya and discussed robotics partnerships.")

    def test_rejects_malformed_json_after_one_repair(self) -> None:
        calls = []

        def chat(messages, _schema):
            calls.append(messages)
            return "still-not-json"

        with self.assertRaises(InferenceError) as captured:
            process_interaction(
                ProcessInteractionRequest(
                    owner_id="own_invalid_json",
                    review_id="review-invalid-json",
                    raw_body="Met someone.",
                ),
                chat=chat,
            )
        self.assertEqual(captured.exception.code, "AI_INVALID_JSON")
        self.assertEqual(len(calls), 2)

    def test_rejects_schema_violation_after_one_repair(self) -> None:
        invalid_schema = json.dumps({"schema_version": "1.0", "warnings": []})
        calls = []

        def chat(messages, _schema):
            calls.append(messages)
            return invalid_schema

        with self.assertRaises(InferenceError) as captured:
            process_interaction(
                ProcessInteractionRequest(
                    owner_id="own_schema_error",
                    review_id="review-schema-error",
                    raw_body="Met someone.",
                ),
                chat=chat,
            )
        self.assertEqual(captured.exception.code, "AI_SCHEMA_ERROR")
        self.assertEqual(len(calls), 2)

    def test_revision_preserves_unaffected_fields(self) -> None:
        existing = InteractionDraft(
            interaction_date=date(2026, 9, 20),
            platform="CALL",
            summary="Spoke with Maya about robotics partnerships.",
            details_json={
                "person": {
                    "name": "Maya Patel",
                    "phone": None,
                    "email": None,
                    "organization": "Acme Robotics",
                    "context_tag": "Robotics",
                },
                "identity": {"confidence": 0.9, "evidence": ["name supplied"]},
                "warnings": [],
            },
            raw_body="Called Maya about robotics partnerships.",
            media_refs=[],
            ai_model="llama3.1:8b",
            schema_version="1.0",
        )

        def chat(messages, _schema):
            return json.dumps(
                {
                    "schema_version": "1.0",
                    "changes": [
                        {"field": "interaction.platform", "value": "VIDEO_CALL"}
                    ],
                }
            )

        revised = revise_draft(
            ReviseDraftRequest(
                owner_id="own_revision_secret",
                review_id="review-revision",
                draft=existing,
                correction="It was a video call, not a phone call.",
            ),
            current_date=date(2026, 9, 23),
            chat=chat,
        )
        self.assertEqual(revised.platform.value, "VIDEO_CALL")
        self.assertEqual(revised.interaction_date, existing.interaction_date)
        self.assertEqual(revised.summary, existing.summary)
        self.assertEqual(revised.details_json, existing.details_json)
        self.assertEqual(revised.raw_body, existing.raw_body)

    def test_revision_prompt_forbids_unrelated_warnings(self) -> None:
        existing = InteractionDraft(
            interaction_date=date(2026, 9, 20),
            platform="CALL",
            summary="Discussed a pilot.",
            details_json={"warnings": []},
            raw_body="Called about a pilot.",
            media_refs=[],
            ai_model="llama3.1:8b",
            schema_version="1.0",
        )
        captured = {}

        def chat(messages, _schema):
            captured["messages"] = messages
            return json.dumps(
                {
                    "schema_version": "1.0",
                    "changes": [
                        {"field": "interaction.platform", "value": "VIDEO_CALL"}
                    ],
                }
            )

        revised = revise_draft(
            ReviseDraftRequest(
                owner_id="own_revision_prompt",
                review_id="review-revision-prompt",
                draft=existing,
                correction="It was a video call, not a phone call.",
            ),
            chat=chat,
        )
        self.assertEqual(revised.details_json["warnings"], [])
        self.assertIn("exactly one change", captured["messages"][0]["content"])
        self.assertIn("warnings change only", captured["messages"][0]["content"])

    def test_revision_cannot_regenerate_unaffected_fields(self) -> None:
        existing = InteractionDraft(
            interaction_date=date(2026, 9, 20),
            platform="CALL",
            summary="Original summary that must remain.",
            details_json={"custom_metadata": {"preserve": True}},
            raw_body="Original body that must remain.",
            media_refs=["media://preserve"],
            ai_model="earlier-model",
            schema_version="1.0",
        )

        def chat(_messages, _schema):
            return json.dumps(
                {
                    "schema_version": "1.0",
                    "changes": [
                        {"field": "interaction.platform", "value": "VIDEO_CALL"}
                    ],
                }
            )

        revised = revise_draft(
            ReviseDraftRequest(
                owner_id="own_patch_guard",
                review_id="review-patch-guard",
                draft=existing,
                correction="It was a video call.",
            ),
            chat=chat,
        )
        self.assertEqual(revised.platform.value, "VIDEO_CALL")
        self.assertEqual(revised.summary, existing.summary)
        self.assertEqual(revised.interaction_date, existing.interaction_date)
        self.assertEqual(revised.details_json, existing.details_json)
        self.assertEqual(revised.raw_body, existing.raw_body)
        self.assertEqual(revised.media_refs, existing.media_refs)

    def test_ollama_connection_failure_is_categorized(self) -> None:
        request = httpx.Request("POST", "http://192.168.0.200:11434/api/chat")
        with patch("app.inference.httpx.Client") as client_type:
            client_type.return_value.__enter__.return_value.post.side_effect = (
                httpx.ConnectError("offline", request=request)
            )
            with self.assertRaises(InferenceError) as captured:
                _ollama_chat([], {})
        self.assertEqual(captured.exception.code, "LOCAL_API_UNAVAILABLE")


if __name__ == "__main__":
    unittest.main()
