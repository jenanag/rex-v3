# 0036: Set the answer-analysis request body limit to 3 MiB

- **Status:** Proposed
- **Date:** 2026-11-24
- **Deciders:** Jay Pascual

## Context

[ADR 0035](0035-answer-analysis-language.md) selects the TypeScript template.
The [answer-analysis request schema](../../packages/contracts/openapi/services/answer-analysis.yaml)
allows 200,000 text characters and up to 50 brands. UTF-8 encoding and JSON
escaping can push valid requests past Fastify's 1 MiB default.

The fixtures below passed both the source and vendored request schemas with
the template's Ajv settings on Node 26.13.1. Sizes are for complete bodies,
measured with `Buffer.byteLength(JSON.stringify(request), "utf8")`.

| Fixture | Serialized bytes | Fits 1 MiB | Fits 2 MiB | Fits 3 MiB |
|---|---:|:---:|:---:|:---:|
| Python spike representative | 1,440 | Yes | Yes | Yes |
| Python spike large, 200,000 ASCII characters and 50 brands | 234,874 | Yes | Yes | Yes |
| 200,000 U+0001 characters and one ordinary brand | 1,200,117 | No | Yes | Yes |
| Combined emoji text and 50 capped brands with sentiment options | 1,495,929 | No | Yes | Yes |
| Combined escaped text and 50 capped brands with sentiment options | 2,112,329 | No | No | Yes |

The [spike workloads](../../spikes/openapi-validation/python/benchmark.py)
define the first two requests. The one-brand escaped fixture uses the spike's
ordinary Acme brand and omits sentiment. The combined fixtures have one primary
and 49 competitors. Each brand has a 64-character key, a 100-character name,
20 aliases of 100 characters, and 20 ASCII hostnames of 253 characters each.
Text is 200,000 code points. Text, keys, names, and aliases use four-byte emoji
or characters that serialize as six-byte JSON escapes, respectively. The
sentiment object supplies five distinct 120-character analyzer IDs, a matching
primary, a 35-character language tag, and `onUnsupportedLanguage: fallback`.

## Decision

Retain the current OpenAPI request schema. At scaffolding, set the tool-wide
Fastify limit to `BODY_LIMIT_BYTES=3145728` (3 MiB). Apply the ceiling to
serialized request body bytes on `POST /v1/answer-analyses`. Requests above it
receive HTTP 413. `GET /v1/analyzers` has no request body.

## Consequences

This ceiling admits the measured combinations of capped declared fields.
[`TrackedBrand`](../../packages/contracts/openapi/common.yaml) permits extra
properties with unconstrained values, so the schema can still describe bodies
above the ceiling. The HTTP byte limit bounds those requests as well.

[ADR 0027](0027-scale-typescript-validation-budget.md) sets a strict
**validator-only p99 < 15 ms** gate per workload (5 ms per MiB × 3). Time the
warmed, registered Fastify validator including default application. Keep JSON
parsing, startup, handler work, and response serialization outside the timed
samples. Fail at p99 ≥ 15 ms without retries or report-only mode.

Scaffolding will configure the limit and run CI verification. Use the Python
spike representative request as the representative workload. Use the spike's
large request and the combined emoji request as intermediate workloads.
Exercise two separate schema-valid workloads at the ceiling:

1. Pad the 2,112,329-byte combined escaped body with 1,033,399 bytes of trailing
   JSON whitespace. It exercises capped declared fields.
2. Add an `extra.data` string of 1,033,379 ASCII `x` characters under the first
   brand in the same combined escaped request. The serialized body reaches the
   ceiling with nested brand data and no padding.

Verify that both bodies reach the registered handler at **3,145,728 bytes**.
Append one byte of JSON whitespace to each and verify HTTP 413.

## Alternatives considered

- **Keep 1 MiB and narrow the request schema.** A tool-local 20,000-character text
  cap and closed brand items would fit the capped declared fields within the
  default. The text restriction would exclude the existing 234,874-byte spike
  request despite its serialized size fitting 1 MiB.
- **Set 2 MiB (2,097,152 bytes).** This admits the one-brand escaped text cap and
  the combined emoji fixture. The combined escaped fixture still exceeds it by
  15,177 bytes.
