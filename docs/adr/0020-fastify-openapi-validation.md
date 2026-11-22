# 0020: Bind Fastify routes to the vendored OpenAPI 3.1 contract

- **Status:** Accepted (2026-11-22)
- **Date:** 2026-11-22
- **Deciders:** Jay Pascual
- **Amended:** 2026-11-22. Deferred the validation budget until tools can be measured.
- **Amended by:** [0026](0026-typescript-validation-budget.md), 2026-11-22 (accepted by Jay). Applies to the validation budget section.

## Context

[Roadmap 1.3](../roadmap.md#13-spikes-request-validation-from-the-vendored-31-spec)
tests how Fastify can validate requests against a tool's bundled OpenAPI 3.1 contract,
including JSON Schema 2020-12 features and the defaults used by callers.
[ADR 0002](0002-typescript-fastify.md) and [ADR 0024](0024-per-tool-language.md) set the
server and validation budget.

## Decision

Use a small operationId-based loader that binds Fastify routes to the bundled spec.
Compile request schemas with `Ajv2020` through `setValidatorCompiler`. Register the
bundle's component schemas as a single `$defs` resource and rebase schema references
into it, preserving reference resolution and composition.

- Set `strict: true`, `allErrors: true`, `removeAdditional: false`,
  `coerceTypes: false`, and `useDefaults: true` on request validators.
- Install `ajv-formats`. Register `example` and the REx extensions
  `x-rex-service`, `x-rex-public`, and `x-rex-limits` as annotations.
- Return the shared `Problem` with HTTP 400, `application/problem+json`, and
  `code: validation_failed`. Map instance paths and offending member names to
  RFC 6901 pointers, escaping `~` and `/`, and report each distinct pointer.
- Use `JSON.stringify` through `setSerializerCompiler`. Contract tests validate
  the wire response against the bundled schema with defaults disabled.

### Validation budget

**Deferred: tune with real tool numbers.** The spike measurements below are
informational. The template will use Fastify's default `bodyLimit` of 1 MiB
(1,048,576 bytes) and allow a per-tool override. Body-size limits can be revisited
when tools exist and can be measured.

## Consequences

Both candidates passed the same [25 request cases](../../spikes/openapi-validation/request-cases.json),
including the expected 400 pointers and request defaults. The current answer-analysis
request covers composition, closed objects, defaults, formats and bundled refs. The
spike-only schema variant exercises nullable type arrays, `oneOf` with null,
`propertyNames`, and a lookahead pattern. Response validation accepted the valid
response and rejected the same response with the required `usage` field removed.

The [spike harness](../../spikes/openapi-validation/README.md) recorded two local
runs using Node 26.13.1 on macOS x64 (Intel Core i5-7267U), Fastify 5.12.8 and
Ajv 8.20.0. They timed the warmed validator inside the HTTP request path, excluding JSON parsing,
startup, the handler, and serialization.

| Candidate | Representative p99, 5,000 samples | Large body p99, 1,000 samples |
|---|---:|---:|
| `fastify-openapi-glue` 4.12.0 | 0.0346–0.0454 ms | 5.7594–11.9452 ms |
| OperationId loader | 0.0360–0.0633 ms | 5.4614–13.3207 ms |

The large request contains 200,000 text characters, 50 brands, and 20 aliases and
domains per brand. Both candidates exceeded 1 ms on the large request in both runs.

## Alternatives considered

- **fastify-openapi-glue with Ajv2020.** It passed all cases and supports broader
  OpenAPI route features. The small loader covers the current tool contracts and
  preserves the schema reference graph through Ajv, with fewer dependencies.
- **fast-json-stringify per route.** It serialized the valid response successfully.
  It also converted an invalid string position to an integer and dropped an extra
  field in the same payload. That output passed the contract check. JSON.stringify
  preserved the payload and exposed the invalid position to the response test.
