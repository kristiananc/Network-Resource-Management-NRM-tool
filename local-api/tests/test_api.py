"""FastAPI contract tests with deterministic mocked Stage 6 inference."""

import json
import os
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.inference import InferenceError
from app.main import app


TOKEN = "stage2-test-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


class Stage6ApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.environment = patch.dict(
            os.environ,
            {"NRM_INTERNAL_API_TOKEN": TOKEN},
            clear=False,
        )
        self.environment.start()
        self.ollama = patch(
            "app.inference._ollama_chat",
            side_effect=self._mock_ollama_chat,
        )
        self.ollama.start()
        self.client = TestClient(app)

    def tearDown(self) -> None:
        self.client.close()
        self.ollama.stop()
        self.environment.stop()

    @staticmethod
    def _mock_ollama_chat(messages, _schema):
        if "revision engine" in messages[0]["content"]:
            return json.dumps(
                {
                    "schema_version": "1.0",
                    "changes": [
                        {
                            "field": "interaction.summary",
                            "value": "Revised factual summary.",
                        }
                    ],
                }
            )
        return json.dumps(
            {
                "schema_version": "1.0",
                "person": {
                    "name": "Sarah Chen",
                    "phone": None,
                    "email": None,
                    "organization": "NAVWAR",
                    "context_tag": "Defense",
                },
                "interaction": {
                    "date": "2026-08-26",
                    "platform": "IN_PERSON",
                    "summary": "Met Sarah for coffee.",
                },
                "identity": {
                    "confidence": 0.91,
                    "evidence": ["name and organization supplied by text"],
                },
                "warnings": [],
            }
        )

    def test_health_is_authenticated_and_deterministic(self) -> None:
        unauthorized = self.client.get("/health")
        self.assertEqual(unauthorized.status_code, 401)

        response = self.client.get("/health", headers=AUTH)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {
                "status": "ok",
                "service": "nrm-local-api",
                "schema_version": "1.0",
            },
        )

    def test_process_interaction_echoes_owner_id_unchanged(self) -> None:
        owner_id = " Own/Test:Opaque-001 "
        response = self.client.post(
            "/process-interaction",
            headers=AUTH,
            json={
                "owner_id": owner_id,
                "review_id": "review_process_001",
                "raw_body": "Met Sarah for coffee.",
                "media_refs": ["media://example-1"],
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {
                "owner_id": owner_id,
                "review_id": "review_process_001",
                "schema_version": "1.0",
                "draft": {
                    "interaction_date": "2026-08-26",
                    "platform": "IN_PERSON",
                    "summary": "Met Sarah for coffee.",
                    "details_json": {
                        "person": {
                            "name": "Sarah Chen",
                            "phone": None,
                            "email": None,
                            "organization": "NAVWAR",
                            "context_tag": "Defense",
                        },
                        "identity": {
                            "confidence": 0.91,
                            "evidence": ["name and organization supplied by text"],
                        },
                        "warnings": [],
                    },
                    "raw_body": "Met Sarah for coffee.",
                    "media_refs": ["media://example-1"],
                    "ai_model": "llama3.1:8b",
                    "schema_version": "1.0",
                },
            },
        )
        repeated = self.client.post(
            "/process-interaction",
            headers=AUTH,
            json={
                "owner_id": owner_id,
                "review_id": "review_process_001",
                "raw_body": "Met Sarah for coffee.",
                "media_refs": ["media://example-1"],
            },
        )
        self.assertEqual(repeated.json(), response.json())

    def test_revise_draft_echoes_owner_id_and_preserves_unaffected_fields(self) -> None:
        owner_id = "own_test_b"
        response = self.client.post(
            "/revise-draft",
            headers=AUTH,
            json={
                "owner_id": owner_id,
                "review_id": "review_revise_001",
                "correction": "Use a different summary.",
                "draft": {
                    "interaction_date": "2026-08-26",
                    "platform": "TEXT",
                    "summary": "Original summary.",
                    "details_json": {"original": True},
                    "raw_body": "Original body",
                    "media_refs": [],
                    "ai_model": "stage2-dummy",
                    "schema_version": "1.0",
                },
            },
        )
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["owner_id"], owner_id)
        self.assertEqual(body["schema_version"], "1.0")
        self.assertEqual(
            body["draft"],
            {
                "interaction_date": "2026-08-26",
                "platform": "TEXT",
                "summary": "Revised factual summary.",
                "details_json": {"original": True},
                "raw_body": "Original body",
                "media_refs": [],
                "ai_model": "llama3.1:8b",
                "schema_version": "1.0",
            },
        )

    def test_invalid_or_unconfigured_authentication_is_rejected(self) -> None:
        invalid = self.client.get(
            "/health",
            headers={"Authorization": "Bearer wrong-token"},
        )
        self.assertEqual(invalid.status_code, 401)
        self.assertEqual(invalid.headers["www-authenticate"], "Bearer")

        with patch.dict(os.environ, {}, clear=True):
            unconfigured = self.client.get("/health", headers=AUTH)
        self.assertEqual(unconfigured.status_code, 503)

    def test_schema_version_and_extra_fields_are_enforced(self) -> None:
        invalid = self.client.post(
            "/revise-draft",
            headers=AUTH,
            json={
                "owner_id": "own_test_a",
                "review_id": "review_invalid",
                "correction": "Correction",
                "unexpected": "not allowed",
                "draft": {
                    "interaction_date": "2026-08-26",
                    "platform": "OTHER",
                    "summary": "Summary",
                    "ai_model": "stage2-dummy",
                    "schema_version": "2.0",
                },
            },
        )
        self.assertEqual(invalid.status_code, 422)

        blank_owner = self.client.post(
            "/process-interaction",
            headers=AUTH,
            json={
                "owner_id": "   ",
                "review_id": "review_blank_owner",
            },
        )
        self.assertEqual(blank_owner.status_code, 422)

    def test_inference_errors_are_clear_and_non_successful(self) -> None:
        request_body = {
            "owner_id": "own_error_test",
            "review_id": "review_error_test",
            "raw_body": "Met someone.",
        }
        cases = [
            ("LOCAL_API_UNAVAILABLE", 503),
            ("AI_INVALID_JSON", 502),
            ("AI_SCHEMA_ERROR", 502),
        ]
        for code, expected_status in cases:
            with self.subTest(code=code):
                with patch(
                    "app.inference._ollama_chat",
                    side_effect=InferenceError(code, "safe test message"),
                ):
                    response = self.client.post(
                        "/process-interaction",
                        headers=AUTH,
                        json=request_body,
                    )
                self.assertEqual(response.status_code, expected_status)
                self.assertEqual(
                    response.json(),
                    {
                        "detail": {
                            "code": code,
                            "message": "safe test message",
                        }
                    },
                )

    def test_structured_logging_contains_metadata_not_secrets_or_body(self) -> None:
        with self.assertLogs("nrm.api", level="INFO") as captured:
            response = self.client.post(
                "/process-interaction",
                headers={
                    **AUTH,
                    "x-request-id": "request-stage2-001",
                },
                json={
                    "owner_id": "own_log_test",
                    "review_id": "review_log_test",
                    "raw_body": "sensitive body must not be logged",
                },
            )
        self.assertEqual(response.status_code, 200)
        event = json.loads(captured.records[-1].getMessage())
        self.assertEqual(
            {
                key: event[key]
                for key in (
                    "event",
                    "request_id",
                    "method",
                    "path",
                    "status_code",
                )
            },
            {
                "event": "http_request",
                "request_id": "request-stage2-001",
                "method": "POST",
                "path": "/process-interaction",
                "status_code": 200,
            },
        )
        log_line = captured.records[-1].getMessage()
        self.assertNotIn(TOKEN, log_line)
        self.assertNotIn("sensitive body", log_line)
        self.assertNotIn("own_log_test", log_line)


if __name__ == "__main__":
    unittest.main()
