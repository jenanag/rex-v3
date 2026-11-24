"""Read the same bundle and supplemental schema as the TypeScript spike."""

from copy import deepcopy
from pathlib import Path

import yaml

SPIKES = Path(__file__).resolve().parents[1]
REPO = SPIKES.parents[1]
BUNDLE = REPO / "services/answer-analysis/contract/openapi.yaml"
MEDIA_TYPE = "application/json"
RESPONSE = {
    "language": None,
    "languageSource": "undetermined",
    "primaryFallback": False,
    "analyzers": [],
    "mentions": [
        {
            "brandKey": "acme",
            "position": 1,
            "occurrences": 1,
            "sentiment": None,
            "sentimentScore": None,
            "sentimentByAnalyzer": [],
            "agreement": None,
            "snippet": "Acme is mentioned.",
        }
    ],
    "usage": [],
}


def load_spec(supplement=False):
    spec = yaml.safe_load(BUNDLE.read_text(encoding="utf-8"))
    if supplement:
        common = yaml.safe_load(
            (REPO / "packages/contracts/openapi/common.yaml").read_text(
                encoding="utf-8"
            )
        )["components"]["schemas"]
        schemas = spec["components"]["schemas"]
        mention = schemas["MentionDetail"]["properties"]
        schemas["AnswerAnalysisRequest"]["properties"] = {
            "spike": {
                "type": "object",
                "unevaluatedProperties": False,
                "properties": {
                    "score": mention["sentimentScore"],
                    "sentiment": mention["sentiment"],
                    "names": {
                        "type": "object",
                        "propertyNames": common["CacheDirective"]["properties"][
                            "overrides"
                        ]["propertyNames"],
                    },
                    "duration": common["IsoDuration"],
                },
            }
        }
    return spec


def operation(spec):
    for path, item in spec["paths"].items():
        for method, definition in item.items():
            if definition.get("operationId") == "analyzeAnswer":
                return method, path, definition
    raise ValueError("analyzeAnswer missing from OpenAPI bundle")


def resolve(spec, ref):
    if not ref.startswith("#/"):
        raise ValueError(f"Expected an internal bundle reference: {ref}")
    for key in ref[2:].split("/"):
        spec = spec[key.replace("~1", "/").replace("~0", "~")]
    return spec


def declared_properties(spec, schema):
    yield from schema.get("properties", {}).items()
    if "$ref" in schema:
        yield from declared_properties(spec, resolve(spec, schema["$ref"]))
    for branch in schema.get("allOf", []):
        yield from declared_properties(spec, branch)


def defaults(spec, schema):
    """Compile property defaults in the bundle's object/$ref/allOf paths once."""
    for key, child in declared_properties(spec, schema):
        if "default" in child:
            yield (key,), child["default"]
        for path, value in defaults(spec, child):
            yield (key, *path), value


def apply_defaults(body, rules):
    for (*parents, key), value in rules:
        target = body
        for parent in parents:
            target = target.get(parent) if isinstance(target, dict) else None
        if isinstance(target, dict) and key not in target:
            target[key] = deepcopy(value)


def pointer(parts):
    return "".join(
        "/" + str(part).replace("~", "~0").replace("/", "~1") for part in parts
    )


def findings(spec, errors):
    details = {}
    for error in errors:
        path = tuple(error.absolute_path)
        if error.validator == "required":
            paths = [
                (*path, key)
                for key in error.validator_value
                if key not in error.instance
            ]
        elif error.validator == "unevaluatedProperties":
            # jsonschema can also report declared members from a failing allOf branch.
            # Keep that branch's specific errors and only locate truly undeclared keys here.
            declared = dict(declared_properties(spec, error.schema))
            paths = [(*path, key) for key in error.instance if key not in declared]
        elif "propertyNames" in error.absolute_schema_path:
            paths = [(*path, error.instance)]
        else:
            paths = [path]
        for location in paths:
            details.setdefault(
                pointer(location), f"Does not satisfy {error.validator}."
            )
    return [
        {"pointer": location, "detail": detail} for location, detail in details.items()
    ]
