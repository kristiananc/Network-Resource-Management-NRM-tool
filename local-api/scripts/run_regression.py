#!/usr/bin/env python3
"""Run the versioned Stage 6 corpus against the configured Ollama model."""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import date
from pathlib import Path
from typing import Any

from app.inference import (
    DEFAULT_OLLAMA_BASE_URL,
    DEFAULT_OLLAMA_MODEL,
    InferenceError,
    _output_from_draft,
    process_interaction,
    revise_draft,
)
from app.models import InteractionDraft, ProcessInteractionRequest, ReviseDraftRequest


DEFAULT_CORPUS = Path(__file__).resolve().parents[1] / "regression" / "corpus.json"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--corpus", type=Path, default=DEFAULT_CORPUS)
    parser.add_argument(
        "--case",
        action="append",
        dest="case_ids",
        help="Run only the named case; repeat this option to select multiple cases.",
    )
    arguments = parser.parse_args()

    corpus = json.loads(arguments.corpus.read_text(encoding="utf-8"))
    current_date = date.fromisoformat(corpus["current_date"])
    cases = corpus["cases"]
    if arguments.case_ids:
        requested = set(arguments.case_ids)
        cases = [case for case in cases if case["id"] in requested]
        missing = requested - {case["id"] for case in cases}
        if missing:
            parser.error("unknown corpus case(s): " + ", ".join(sorted(missing)))
    model = os.environ.get("NRM_OLLAMA_TEXT_MODEL", DEFAULT_OLLAMA_MODEL)
    base_url = os.environ.get("NRM_OLLAMA_BASE_URL", DEFAULT_OLLAMA_BASE_URL)
    print(f"NRM Stage 6 regression: model={model} base_url={base_url}")
    print(f"current_date={current_date.isoformat()} cases={len(cases)}")

    failures = 0
    for case in cases:
        print(f"\nCASE {case['id']} ({case['type']})")
        print("INPUT:")
        print(case.get("raw_body", case.get("correction", "")))
        try:
            actual = run_case(case, current_date)
            print("ACTUAL:")
            print(json.dumps(actual, indent=2, sort_keys=True))
            errors = compare(case["expected"], actual)
        except InferenceError as error:
            errors = [f"{error.code}: {error.message}"]
            print("ACTUAL:")
            print(json.dumps({"error": error.code, "message": error.message}, indent=2))

        if errors:
            failures += 1
            print("RESULT: FAIL")
            for error in errors:
                print(f"- {error}")
        else:
            print("RESULT: PASS")

    passed = len(cases) - failures
    print(f"\nSUMMARY: {passed}/{len(cases)} passed; {failures} failed")
    return 1 if failures else 0


def run_case(case: dict[str, Any], current_date: date) -> dict[str, Any]:
    if case["type"] == "process":
        draft = process_interaction(
            ProcessInteractionRequest(
                owner_id=case["owner_id"],
                review_id=f"regression-{case['id']}",
                raw_body=case["raw_body"],
                media_refs=[],
            ),
            current_date=current_date,
        )
    elif case["type"] == "revise":
        draft = revise_draft(
            ReviseDraftRequest(
                owner_id=case["owner_id"],
                review_id=f"regression-{case['id']}",
                draft=InteractionDraft.model_validate(case["draft"]),
                correction=case["correction"],
            ),
            current_date=current_date,
        )
    else:
        raise ValueError(f"Unsupported case type: {case['type']}")
    return _output_from_draft(draft).model_dump(mode="json")


def compare(expected: dict[str, Any], actual: dict[str, Any]) -> list[str]:
    errors = []
    for path, expected_value in expected.get("exact", {}).items():
        actual_value = value_at_path(actual, path)
        if actual_value != expected_value:
            errors.append(f"{path}: expected {expected_value!r}, got {actual_value!r}")

    summary = str(value_at_path(actual, "interaction.summary") or "").casefold()
    for fragment in expected.get("summary_contains", []):
        if fragment.casefold() not in summary:
            errors.append(f"interaction.summary missing {fragment!r}: {summary!r}")
    for fragment in expected.get("summary_excludes", []):
        if fragment.casefold() in summary:
            errors.append(f"interaction.summary unexpectedly contains {fragment!r}: {summary!r}")

    warnings_min = expected.get("warnings_min")
    if warnings_min is not None and len(actual.get("warnings", [])) < warnings_min:
        errors.append(
            f"warnings: expected at least {warnings_min}, got {len(actual.get('warnings', []))}"
        )
    warnings_exact = expected.get("warnings_exact")
    if warnings_exact is not None and actual.get("warnings") != warnings_exact:
        errors.append(
            f"warnings: expected exactly {warnings_exact!r}, got {actual.get('warnings')!r}"
        )
    return errors


def value_at_path(value: dict[str, Any], path: str) -> Any:
    current: Any = value
    for segment in path.split("."):
        if not isinstance(current, dict) or segment not in current:
            return None
        current = current[segment]
    return current


if __name__ == "__main__":
    sys.exit(main())
