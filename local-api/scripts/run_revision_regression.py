#!/usr/bin/env python3
"""Print controlled before/after drafts for revision-scope regressions."""

from __future__ import annotations

import json
import sys
from datetime import date
from typing import Any, Callable

from app.inference import revise_draft
from app.models import InteractionDraft, ReviseDraftRequest


PatchFactory = Callable[[], list[dict[str, Any]]]


def base_draft(*, unidentified: bool = False) -> InteractionDraft:
    return InteractionDraft(
        interaction_date=date(2026, 9, 20),
        platform="CALL",
        summary=(
            "Discussed a potential collaboration."
            if unidentified
            else "Discussed a warehouse automation pilot."
        ),
        details_json={
            "person": {
                "name": None if unidentified else "Maya Patel",
                "phone": None,
                "email": None,
                "organization": None if unidentified else "Acme Robotics",
                "context_tag": None if unidentified else "Robotics",
            },
            "identity": {
                "confidence": 0.2 if unidentified else 0.9,
                "evidence": [] if unidentified else ["name supplied"],
            },
            "warnings": ["Person identity was not supplied."] if unidentified else [],
        },
        raw_body=(
            "Spoke with a new contact about a collaboration."
            if unidentified
            else "Called Maya about the warehouse automation pilot."
        ),
        media_refs=[],
        ai_model="llama3.1:8b",
        schema_version="1.0",
    )


def kris_angell_draft() -> InteractionDraft:
    return InteractionDraft(
        interaction_date=None,
        platform=None,
        summary=(
            "president of the toastmasters club recently opened her own "
            "winery business"
        ),
        details_json={
            "person": {
                "name": "Kris Angell",
                "phone": None,
                "email": None,
                "organization": None,
                "context_tag": "Toastmasters",
            },
            "identity": {
                "confidence": 0.9,
                "evidence": ["winery content retained"],
            },
            "warnings": [],
        },
        raw_body=(
            "The president of the toastmasters club is Kris Angell. Recently "
            "opened her own winery touring business..."
        ),
        media_refs=[],
        ai_model="llama3.1:8b",
        schema_version="1.0",
    )


def run_case(
    *,
    case_id: str,
    existing: InteractionDraft,
    correction: str,
    outputs: list[dict[str, Any]],
    verify: Callable[[InteractionDraft], None],
) -> bool:
    pending = iter(outputs)
    model_calls = 0

    def chat(_messages, _schema):
        nonlocal model_calls
        model_calls += 1
        return json.dumps(next(pending))

    revised = revise_draft(
        ReviseDraftRequest(
            owner_id="own_revision_regression",
            review_id=f"revision-{case_id}",
            draft=existing,
            correction=correction,
        ),
        current_date=date(2026, 10, 1),
        chat=chat,
    )

    print(f"CASE: {case_id}")
    print("CORRECTION:")
    print(correction)
    print("BEFORE:")
    print(json.dumps(existing.model_dump(mode="json"), indent=2, sort_keys=True))
    print("AFTER:")
    print(json.dumps(revised.model_dump(mode="json"), indent=2, sort_keys=True))
    print(f"MODEL_CALLS: {model_calls}")
    try:
        verify(revised)
    except AssertionError as error:
        print(f"RESULT: FAIL — {error}")
        return False
    print("RESULT: PASS")
    return True


def main() -> int:
    corrected_summary = (
        "Discussed a warehouse automation pilot and data-integration constraints."
    )
    results = [
        run_case(
            case_id="platform_only_kris_angell",
            existing=kris_angell_draft(),
            correction="In person",
            outputs=[
                {
                    "schema_version": "1.0",
                    "changes": [
                        {"field": "interaction.platform", "value": "IN_PERSON"},
                        {
                            "field": "interaction.summary",
                            "value": (
                                "president of the Toastmasters Club spoke in person"
                            ),
                        },
                    ],
                },
                {
                    "schema_version": "1.0",
                    "changes": [
                        {"field": "interaction.platform", "value": "IN_PERSON"}
                    ],
                },
            ],
            verify=lambda draft: (
                _assert_equal(draft.platform.value, "IN_PERSON"),
                _assert_equal(
                    draft.summary,
                    "president of the toastmasters club recently opened her own winery business",
                ),
                _assert_equal(draft.interaction_date, None),
            ),
        ),
        run_case(
            case_id="date_only",
            existing=kris_angell_draft(),
            correction="October 3, 2026",
            outputs=[
                {
                    "schema_version": "1.0",
                    "changes": [
                        {"field": "interaction.date", "value": "2026-10-03"},
                        {
                            "field": "interaction.summary",
                            "value": "Discussed the winery business on October 3.",
                        },
                    ],
                },
                {
                    "schema_version": "1.0",
                    "changes": [
                        {"field": "interaction.date", "value": "2026-10-03"}
                    ],
                },
            ],
            verify=lambda draft: (
                _assert_equal(draft.interaction_date, date(2026, 10, 3)),
                _assert_equal(draft.platform, None),
                _assert_equal(
                    draft.summary,
                    "president of the toastmasters club recently opened her own winery business",
                ),
            ),
        ),
        run_case(
            case_id="substantive_identity_and_topic",
            existing=base_draft(unidentified=True),
            correction=(
                "The person was Maya Patel from Acme Robotics, and we discussed "
                "a warehouse automation pilot."
            ),
            outputs=[
                {
                    "schema_version": "1.0",
                    "changes": [
                        {"field": "person.name", "value": "Maya Patel"},
                        {
                            "field": "person.organization",
                            "value": "Acme Robotics",
                        },
                        {"field": "identity.confidence", "value": 0.95},
                        {
                            "field": "identity.evidence",
                            "value": [
                                "Correction supplied full name and organization."
                            ],
                        },
                        {"field": "warnings", "value": []},
                    ],
                },
                {
                    "schema_version": "1.0",
                    "changes": [
                        {"field": "person.name", "value": "Maya Patel"},
                        {
                            "field": "person.organization",
                            "value": "Acme Robotics",
                        },
                        {
                            "field": "interaction.summary",
                            "value": (
                                "Discussed a warehouse automation pilot with an "
                                "Acme Robotics contact."
                            ),
                        },
                        {"field": "identity.confidence", "value": 0.95},
                        {
                            "field": "identity.evidence",
                            "value": [
                                "Correction supplied full name and organization."
                            ],
                        },
                        {"field": "warnings", "value": []},
                    ],
                },
            ],
            verify=lambda draft: (
                _assert_equal(draft.details_json["person"]["name"], "Maya Patel"),
                _assert_equal(
                    draft.details_json["person"]["organization"], "Acme Robotics"
                ),
                _assert_equal(
                    draft.summary,
                    "Discussed a warehouse automation pilot with an Acme Robotics contact.",
                ),
                _assert_equal(draft.details_json["identity"]["confidence"], 0.95),
                _assert_equal(draft.details_json["warnings"], []),
                _assert_equal(draft.interaction_date, date(2026, 9, 20)),
                _assert_equal(draft.platform.value, "CALL"),
            ),
        ),
        run_case(
            case_id="identity_typo_only",
            existing=base_draft(),
            correction="Her name is Maia Patel, not Maya Patel.",
            outputs=[
                {
                    "schema_version": "1.0",
                    "changes": [
                        {"field": "person.name", "value": "Maia Patel"},
                        {
                            "field": "interaction.summary",
                            "value": "Discussed a pilot with Maia Patel.",
                        },
                    ],
                },
                {
                    "schema_version": "1.0",
                    "changes": [
                        {"field": "person.name", "value": "Maia Patel"}
                    ],
                },
            ],
            verify=lambda draft: (
                _assert_equal(draft.details_json["person"]["name"], "Maia Patel"),
                _assert_equal(
                    draft.summary, "Discussed a warehouse automation pilot."
                ),
                _assert_equal(draft.interaction_date, date(2026, 9, 20)),
                _assert_equal(draft.platform.value, "CALL"),
            ),
        ),
        run_case(
            case_id="topic_without_date_or_platform",
            existing=base_draft(),
            correction="Add that we also discussed data-integration constraints.",
            outputs=[
                {
                    "schema_version": "1.0",
                    "changes": [
                        {"field": "interaction.summary", "value": corrected_summary},
                        {"field": "interaction.date", "value": "2026-09-30"},
                        {"field": "interaction.platform", "value": "VIDEO_CALL"},
                    ],
                },
                {
                    "schema_version": "1.0",
                    "changes": [
                        {"field": "interaction.summary", "value": corrected_summary}
                    ],
                },
            ],
            verify=lambda draft: (
                _assert_equal(draft.summary, corrected_summary),
                _assert_equal(draft.interaction_date, date(2026, 9, 20)),
                _assert_equal(draft.platform.value, "CALL"),
            ),
        ),
    ]
    passed = sum(results)
    print(f"SUMMARY: {passed}/{len(results)} passed")
    return 0 if passed == len(results) else 1


def _assert_equal(actual: Any, expected: Any) -> None:
    if actual != expected:
        raise AssertionError(f"expected {expected!r}, got {actual!r}")


if __name__ == "__main__":
    sys.exit(main())
