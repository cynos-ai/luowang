"""Live, disposable cross-Run cleanup check for the Python acceptance fixture.

Run inside the fixture container, where its non-production cleanup token is already
available. This is an independent environment check, not a Reviewer scene verdict.
"""

import json
import os
import secrets
import sys
from urllib.error import HTTPError
from urllib.request import Request, urlopen


ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
BASE = os.environ.get("LUOWANG_FIXTURE_BASE_URL", "http://127.0.0.1:3100").rstrip("/")
TOKEN = os.environ["CYNOS_TEST_DATA_CLEANUP_TOKEN"]
if len(TOKEN) < 32:
    raise SystemExit("The fixture cleanup token is unavailable")


def request(method, path, body=None, authorized=False):
    headers = {"Content-Type": "application/json"}
    if authorized:
        headers["Authorization"] = f"Bearer {TOKEN}"
    payload = json.dumps(body).encode() if body is not None else None
    try:
        with urlopen(Request(f"{BASE}{path}", data=payload, headers=headers, method=method), timeout=10) as response:
            return response.status, json.load(response)
    except HTTPError as error:
        return error.code, json.load(error)


def run_id():
    return "01" + "".join(secrets.choice(ALPHABET) for _ in range(24))


def count(identity):
    status, body = request("GET", f"/api/luowang/test-data/{identity}", authorized=True)
    if status != 200 or body.get("runId") != identity:
        raise AssertionError(f"Count request failed: HTTP {status}")
    return body["remaining"]


def delete(identity):
    status, body = request("DELETE", f"/api/luowang/test-data/{identity}", authorized=True)
    if status != 200 or body.get("runId") != identity:
        raise AssertionError(f"Cleanup request failed: HTTP {status}")
    return body["deleted"], body["remaining"]


def register(identity):
    prefix = f"luowang-{identity.lower()}-"
    status, _ = request("POST", "/api/auth/register", {
        "email": f"{prefix}scope@example.test",
        "displayName": f"{prefix}scope",
        "password": secrets.token_urlsafe(24),
    })
    if status != 201:
        raise AssertionError(f"Registration failed: HTTP {status}")


def main():
    current, control = run_id(), run_id()
    while control == current:
        control = run_id()
    result = {"currentRunId": current, "controlRunId": control}
    primary_error = None
    try:
        register(current)
        register(control)
        result["before"] = {"current": count(current), "control": count(control)}
        if result["before"] != {"current": 1, "control": 1}:
            raise AssertionError("Expected one account in each synthetic Run")
        result["currentCleanup"] = delete(current)
        result["after"] = {"current": count(current), "control": count(control)}
        if result["after"] != {"current": 0, "control": 1}:
            raise AssertionError("Current Run cleanup changed the control Run")
    except Exception as error:
        primary_error = error
    finally:
        cleanup_errors = []
        for identity in (current, control):
            try:
                delete(identity)
                if count(identity) != 0:
                    raise AssertionError("Cleanup left synthetic data")
            except Exception as error:
                cleanup_errors.append(f"{identity}: {error}")
        result["finalRemaining"] = {
            "current": count(current) if not cleanup_errors else None,
            "control": count(control) if not cleanup_errors else None,
        }
        result["passed"] = primary_error is None and not cleanup_errors
        print(json.dumps(result, ensure_ascii=False))
        if cleanup_errors:
            print("; ".join(cleanup_errors), file=sys.stderr)
        if primary_error:
            print(str(primary_error), file=sys.stderr)
        if not result["passed"]:
            raise SystemExit(1)


if __name__ == "__main__":
    main()
