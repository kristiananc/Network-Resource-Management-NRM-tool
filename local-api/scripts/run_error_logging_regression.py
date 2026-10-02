#!/usr/bin/env python3
"""Reproduce a fast media failure and print its structured diagnostics."""

from __future__ import annotations

import json
import os
import sys
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.main import app
from app.media import MediaError


TOKEN = "diagnostic-regression-token"
MEDIA_URL = (
    "https://api.twilio.com/2010-04-01/Accounts/"
    "AC00000000000000000000000000000000/"
    "Messages/MM11111111111111111111111111111111/"
    "Media/ME22222222222222222222222222222222"
)


def main() -> int:
    failure = MediaError(
        "MEDIA_TYPE_NOT_ALLOWED",
        "Only JPEG, PNG, and WebP images are accepted.",
        stage="media_validation",
        diagnostic=(
            "Twilio media returned disallowed Content-Type application/octet-stream."
        ),
    )
    with patch.dict(
        os.environ,
        {"NRM_INTERNAL_API_TOKEN": TOKEN},
        clear=False,
    ), patch(
        "app.inference.temporary_twilio_media",
        side_effect=failure,
    ), TestClient(app) as client:
        response = client.post(
            "/process-interaction",
            headers={
                "Authorization": f"Bearer {TOKEN}",
                "x-request-id": "diagnostic-regression-001",
            },
            json={
                "owner_id": "own_diagnostic_regression",
                "review_id": "review_diagnostic_regression",
                "raw_body": "private caption not present in logs",
                "media_refs": [MEDIA_URL],
            },
        )

    print(f"RESPONSE_STATUS: {response.status_code}")
    print("RESPONSE_BODY:")
    print(json.dumps(response.json(), indent=2, sort_keys=True))
    passed = (
        response.status_code == 502
        and response.json().get("detail", {}).get("code")
        == "MEDIA_TYPE_NOT_ALLOWED"
    )
    print(f"RESULT: {'PASS' if passed else 'FAIL'}")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
