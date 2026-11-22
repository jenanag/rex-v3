# 0029: Set the llms-txt-generator request body limit to 12 MiB

- **Status:** Accepted (2026-11-23, accepted by Jay)
- **Date:** 2026-11-23
- **Deciders:** Jay Pascual

## Context

The TypeScript template uses Fastify's 1 MiB default (1,048,576 bytes) with a
per-tool override. The `llms-txt-generator` request schemas allow both extracted
text and Markdown in one `describePage` call. Validation accepts either inline
content or a supplied fetched-file result. Character limits on these fields allow
serialized bodies larger than the default. Assembly has neither a `maxItems`
on `pages` nor a `maxLength` on each page's Markdown.
[ADR 0020](0020-fastify-openapi-validation.md#validation-budget) ·
[Source OpenAPI](../../packages/contracts/openapi/services/llms-txt-generator.yaml) ·
[Shared schemas](../../packages/contracts/openapi/common.yaml).

Each fixture below passed the current request schemas with the template's Ajv
validator. Sizes are for complete requests measured with
`Buffer.byteLength(JSON.stringify(request), "utf8")`. The three-page case uses
Markdown excerpts from repo docs. The other cases are synthetic.

| Operation and fixture | Serialized bytes | Fits 12 MiB |
|---|---:|---|
| `describePage`, 1M ASCII characters each in text and Markdown | 2,000,242 | Yes |
| `describePage`, 1M JSON-escaped control characters each in text and Markdown | 12,000,242 | Yes |
| `generateLlmsTxt`, three entries with repo Markdown | 7,037 | Yes |
| `generateLlmsTxt`, 20 entries with 2M ASCII Markdown characters including newlines | 2,252,403 | Yes |
| `generateLlmsTxt`, 5,000 entries with 2M JSON-escaped control characters in Markdown | 12,763,123 | No |
| `generateLlmsTxt`, 20,000 entries with 1,000-character ASCII descriptions | 21,797,844 | No |
| `validateLlmsTxt`, 1M mostly CJK characters inline | 2,999,867 | Yes |
| `validateLlmsTxt`, 500,000 mostly CJK characters in a fetched-file result | 1,499,926 | Yes |

## Decision

Keep the current OpenAPI request schemas. The tool-wide Fastify ceiling is
12 MiB (12,582,912 bytes) of serialized request body data, including on
`POST /v1/llms-txt/validate`, the public validation operation. Requests above
the ceiling receive HTTP 413. The assembly schema can still describe valid
requests larger than the ceiling. Set `BODY_LIMIT_BYTES=12582912` during
scaffolding.
[ADR 0026](0026-typescript-validation-budget.md#consequences).

## Consequences

The tool can receive larger request bodies on all three operations, including
public validation. The per-tool CI budget is **60 ms p99** (`5 × 12`) for the
warmed request validator, applied separately to each representative, intermediate,
and exact-limit workload. JSON parsing, startup, handler work, and response
serialization are outside that timing. The later scaffolding work will verify
the budget in CI with valid bodies at the exact configured limit.
[ADR 0027](0027-scale-typescript-validation-budget.md).

## Alternatives considered

- **Keep 1 MiB and narrow the request schemas.** One option used fixed assembly
  caps of 50 pages, or 35 when any page supplied Markdown, and limited Markdown
  to 1,500 characters per page. That would reject the 7,037-byte three-page
  assembly fixture because one page's Markdown exceeds the proposed field cap.
  It would also impose fixed page-count caps on assembly requests that fit the
  byte ceiling.
