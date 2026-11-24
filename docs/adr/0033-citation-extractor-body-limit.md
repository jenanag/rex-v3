# 0033: Set the citation-extractor request body limit to 4 MiB

- **Status:** Proposed
- **Date:** 2026-11-24
- **Deciders:** Jay Pascual

## Context

[ADR 0032](0032-citation-extractor-language.md) selects the TypeScript template,
which uses Fastify's 1 MiB default (1,048,576 bytes) with a per-tool override.
The [citation-extraction request](../../packages/contracts/openapi/services/citation-extractor.yaml)
accepts Markdown, engine sources, and tracked brands. Markdown has a
200,000-character cap. UTF-8 encoding and JSON escaping can make a request
exceed the default even with both arrays empty. Combined requests also carry
source URLs, titles, and brand data.

The synthetic fixtures below passed the source and vendored request schemas
using the template's Ajv configuration on Node 26.13.1. Sizes are for complete
requests measured with `Buffer.byteLength(JSON.stringify(request), "utf8")`.

| Fixture | Serialized bytes | Fits 1 MiB | Fits 2 MiB | Fits 4 MiB |
|---|---:|:---:|:---:|:---:|
| Markdown of 200,000 U+0001 characters, empty source and brand arrays | 1,200,040 | No | Yes | Yes |
| ASCII Markdown cap, 10,000 short sources, 50 capped ASCII brands | 1,349,379 | No | Yes | Yes |
| Emoji Markdown cap, 250 long sources, 50 capped emoji brands | 2,517,877 | No | No | Yes |
| Escaped Markdown cap, 250 long sources, 50 capped escaped brands | 3,383,377 | No | No | Yes |
| Escaped Markdown cap, 500 long sources, 50 capped escaped brands | 4,666,377 | No | No | No |
| Empty Markdown, no brands, one source with a title of 700,000 U+0001 characters | 4,200,095 | No | No | No |
| Empty Markdown, no brands, one source with an extra nested string of 4,194,304 ASCII characters | 4,194,408 | No | No | No |

The combined fixtures use 200,000 Markdown characters of the indicated kind.
Emoji is U+1F600 at four UTF-8 bytes per character. The escaped fixtures use
U+0001 at six serialized bytes per character. Short sources use numbered
`https://example.test/s/` URLs and numbered titles. Long sources use
2,048-character ASCII URLs and 512-character titles filled with the indicated
character and a numeric suffix. Each capped brand has a 64-character key, a
100-character name, 20 aliases of 100 characters, and 20 hostnames of 253
characters. Hostnames and numeric suffixes are ASCII.

## Decision

Retain the current OpenAPI request schema. At scaffolding, set the tool-wide
Fastify limit `BODY_LIMIT_BYTES=4194304` (4 MiB) for
`POST /v1/citation-extractions`. Apply the ceiling to serialized request
body bytes. Requests above it receive HTTP 413.

## Consequences

The tool can receive larger bodies for JSON parsing and citation extraction.
The request schema can still describe bodies above the ceiling because source
count and title length are unbounded and shared source and brand objects
allow extra properties. [Shared schemas](../../packages/contracts/openapi/common.yaml).

Under [ADR 0027](0027-scale-typescript-validation-budget.md), the per-tool CI gate
requires **validator-only p99 below 20 ms** (5 ms per MiB × 4). Measure the
warmed Fastify request validator including default application, with JSON
parsing, startup, handler work, and response serialization outside the timed
samples. Apply the gate separately to representative, intermediate, and
exact-limit workloads. Fail at p99 ≥ 20 ms without retries or report-only mode.

Scaffolding will configure the limit and run the benchmark. Include separate
exact-limit workloads for long strings and for many short sources. Verify
that each schema-valid body at 4,194,304 bytes reaches the handler. Append
one byte of JSON whitespace to each body and verify HTTP 413.

## Alternatives considered

- **Keep the 1 MiB default.** The escaped Markdown-only fixture and large ASCII
  combination exceed it. Narrowing the contract to fit this ceiling would
  also exclude smaller, currently valid requests, such as the ASCII Markdown
  cap under a proposed 80,000-character restriction.
- **Set 2 MiB (2,097,152 bytes).** It admits the escaped Markdown-only fixture
  and large ASCII combination. Both combined 250-long-source fixtures exceed it.
