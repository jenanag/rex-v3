"""Fallback for the spike's JSON-only, body-only bundled operation."""

from jsonschema import Draft202012Validator

from contract import MEDIA_TYPE, apply_defaults, defaults


def make_route_validator(spec, definition):
    media = definition["requestBody"]["content"]
    if set(media) != {MEDIA_TYPE}:
        raise ValueError("The spike loader only handles a JSON request body")
    if (
        definition.get("parameters")
        or definition.get("security")
        or spec.get("security")
    ):
        raise ValueError("The spike loader only handles a public body-only operation")
    schema = media[MEDIA_TYPE]["schema"]
    default_rules = tuple(defaults(spec, schema))
    # Keep the bundle's reference root so #/components/schemas/... resolves as-is.
    validator = Draft202012Validator(
        {**schema, "components": spec["components"]},
        format_checker=Draft202012Validator.FORMAT_CHECKER,
    )

    def validate(request):
        if request.body is None:
            return [ValueError("Expected a JSON request body")]
        value = request.body.value
        apply_defaults(value, default_rules)
        return list(validator.iter_errors(value))

    return validate
