"""FastAPI spike with the bundled OpenAPI contract as the runtime boundary."""

import json
import math
import secrets
from dataclasses import dataclass
from time import perf_counter_ns
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from jsonschema.exceptions import ValidationError
from jsonschema_path import SchemaPath
from openapi_core import V31RequestValidator, V31ResponseValidator
from openapi_core.datatypes import RequestParameters
from openapi_core.validation.schemas.exceptions import InvalidSchemaValue

from contract import (
    MEDIA_TYPE,
    RESPONSE,
    apply_defaults,
    defaults,
    findings,
    load_spec,
    operation,
)

from route_loader import make_route_validator

CANDIDATES = ("openapi-core", "route-loader")

class ParsedBody(bytes):
    def __new__(cls, raw: bytes, value: Any):
        body = super().__new__(cls, raw)
        body.value = value
        return body


def decoded_json(body: ParsedBody, **_parameters):
    return body.value


@dataclass
class OpenAPIRequest:
    host_url: str
    path: str
    method: str
    content_type: str
    parameters: RequestParameters
    body: ParsedBody | None = None


@dataclass
class OpenAPIResponse:
    status_code: int
    headers: dict
    data: bytes

    @property
    def content_type(self):
        return self.headers["content-type"]


def json_number(token):
    value = float(token)
    if not math.isfinite(value):
        raise ValueError("Non-finite JSON number")
    return value


def problem(path, errors):
    return JSONResponse(
        {
            "type": "https://problems.rex.invalid/validation_failed",
            "title": "Request validation failed",
            "status": 400,
            "code": "validation_failed",
            "traceId": secrets.token_hex(16),
            "instance": path,
            "errors": errors,
        },
        status_code=400,
        media_type="application/problem+json",
    )


def response_validator(spec):
    return V31ResponseValidator(
        SchemaPath.from_dict(spec),
        extra_media_type_deserializers={"application/problem+json": json.loads},
    )


def make_validator(spec, definition):
    schema = definition["requestBody"]["content"][MEDIA_TYPE]["schema"]
    default_rules = tuple(defaults(spec, schema))
    validator = V31RequestValidator(
        SchemaPath.from_dict(spec),
        extra_media_type_deserializers={MEDIA_TYPE: decoded_json},
    )

    def validate(request):
        if request.body is not None:
            apply_defaults(request.body.value, default_rules)
        return list(validator.iter_errors(request))

    return validate


def server(
    spec=None, measure=None, received=None, result=None, *, candidate="openapi-core"
):
    spec = load_spec() if spec is None else spec
    method, path, definition = operation(spec)
    factories = {"openapi-core": make_validator, "route-loader": make_route_validator}
    validate = factories[candidate](spec, definition)
    app = FastAPI(openapi_url=None, docs_url=None, redoc_url=None)

    @app.middleware("http")
    async def validate_analysis(request: Request, call_next):
        if request.method.lower() != method or request.url.path != path:
            return await call_next(request)
        raw = await request.body()
        content_type = request.headers.get("content-type", "").lower()
        body = None
        if raw and content_type.split(";", 1)[0].strip() == MEDIA_TYPE:
            try:
                body = ParsedBody(
                    raw,
                    json.loads(
                        raw, parse_constant=json_number, parse_float=json_number
                    ),
                )
            except (ValueError, RecursionError):
                return problem(
                    path, [{"pointer": "", "detail": "Malformed JSON body."}]
                )
        adapted = OpenAPIRequest(
            str(request.base_url),
            path,
            method,
            content_type,
            RequestParameters(header=request.headers, query=request.query_params),
            body,
        )
        if measure is None:
            errors = validate(adapted)
        else:
            start = perf_counter_ns()
            errors = validate(adapted)
            measure((perf_counter_ns() - start) / 1_000_000)
        if errors:
            schema_errors = []
            for error in errors:
                if isinstance(error, ValidationError):
                    schema_errors.append(error)
                elif isinstance(error.__cause__, InvalidSchemaValue):
                    schema_errors.extend(error.__cause__.schema_errors)
            return problem(
                path,
                findings(spec, schema_errors)
                or [
                    {
                        "pointer": "",
                        "detail": "Request does not satisfy the OpenAPI operation.",
                    }
                ],
            )
        request.state.validated_body = body.value
        return await call_next(request)

    @app.api_route(path, methods=[method.upper()])
    async def handler(request: Request):
        if received:
            received(request.state.validated_body)
        return JSONResponse(result() if result else RESPONSE)

    return app
