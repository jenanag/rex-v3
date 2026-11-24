import json
import re
from copy import deepcopy

import pytest
from fastapi.testclient import TestClient
from openapi_core.datatypes import RequestParameters
from openapi_core.validation.schemas.exceptions import InvalidSchemaValue

from contract import MEDIA_TYPE, RESPONSE, SPIKES, load_spec, operation
from spike import (
    CANDIDATES,
    OpenAPIRequest,
    OpenAPIResponse,
    response_validator,
    server,
)

CASES = json.loads((SPIKES / "request-cases.json").read_text(encoding="utf-8"))
assert len(CASES) == 25
SPEC = load_spec()
SUPPLEMENTED = load_spec(supplement=True)
METHOD, PATH, _ = operation(SPEC)
WIRE_REQUEST = OpenAPIRequest(
    "http://testserver/", PATH, METHOD, MEDIA_TYPE, RequestParameters()
)


def check_response(response):
    return list(
        response_validator(SPEC).iter_errors(
            WIRE_REQUEST,
            OpenAPIResponse(
                response.status_code, dict(response.headers), response.content
            ),
        )
    )


@pytest.mark.parametrize("candidate", CANDIDATES)
@pytest.mark.parametrize("case", CASES, ids=[case["name"] for case in CASES])
def test_shared_request_cases(case, candidate):
    seen = []
    spec = SUPPLEMENTED if case.get("supplement") else SPEC
    with TestClient(server(spec, received=seen.append, candidate=candidate)) as client:
        response = client.post(PATH, json=case["body"])
    assert response.status_code == case["status"], response.text
    assert check_response(response) == []
    if case["status"] == 400:
        assert not seen
        assert response.headers["content-type"] == "application/problem+json"
        problem = response.json()
        assert problem["code"] == "validation_failed"
        assert re.fullmatch("[a-f0-9]{32}", problem["traceId"])
        assert sorted(error["pointer"] for error in problem["errors"]) == sorted(
            case["pointers"]
        )
    else:
        expected = deepcopy(case["body"])
        if "sentiment" in case:
            expected["sentiment"] = case["sentiment"]
        elif "sentiment" in expected:
            expected["sentiment"].setdefault("onUnsupportedLanguage", "fallback")
        assert seen == [expected]


@pytest.mark.parametrize("candidate", CANDIDATES)
def test_wire_response_requires_usage(candidate):
    response_body = deepcopy(RESPONSE)
    with TestClient(
        server(result=lambda: response_body, candidate=candidate)
    ) as client:
        valid = client.post(PATH, json=CASES[0]["body"])
        del response_body["usage"]
        missing = client.post(PATH, json=CASES[0]["body"])
    assert valid.status_code == missing.status_code == 200
    assert check_response(valid) == []
    errors = check_response(missing)
    assert len(errors) == 1
    cause = errors[0].__cause__
    assert isinstance(cause, InvalidSchemaValue)
    assert [
        (e.validator, "usage" in e.validator_value) for e in cause.schema_errors
    ] == [("required", True)]


@pytest.mark.parametrize("candidate", CANDIDATES)
@pytest.mark.parametrize("content", [b"", b"{", b"NaN", b"null"])
def test_missing_malformed_and_null_json(content, candidate):
    with TestClient(server(candidate=candidate)) as client:
        response = client.post(
            PATH, content=content, headers={"content-type": MEDIA_TYPE}
        )
    assert response.status_code == 400
    assert check_response(response) == []
    assert response.json()["code"] == "validation_failed"
    assert [error["pointer"] for error in response.json()["errors"]] == [""]
