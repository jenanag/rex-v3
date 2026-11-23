# 0031: Set request body limits for content-auditor

- **Status:** Proposed
- **Date:** 2026-11-24
- **Deciders:** Jay Pascual

## Context

[ADR 0030](0030-content-auditor-language.md) selects the TypeScript template,
whose Fastify request body limit defaults to 1,048,576 bytes (1 MiB).
`auditPage` combines raw HTML and headers with extracted text and Markdown
and can also receive a robots.txt result and llms.txt validation findings.
The public `checkCrawlerAccess` route receives a single robots.txt result.
The character caps in both request schemas can produce byte sizes above
the default, including at the HTML cap with ASCII and at the robots.txt cap
with multibyte text. The public route needs a smaller ceiling because it
processes one fetched file and is exposed anonymously through the gateway.
[Source OpenAPI](../../packages/contracts/openapi/services/content-auditor.yaml).

The sizing review validated these synthetic fixtures with the template's Ajv
configuration against both the source and vendored request schemas. Sizes are
for the complete request, measured by `Buffer.byteLength(JSON.stringify(request), "utf8")`.

| Operation and fixture | Serialized bytes | Fits proposed ceiling |
|---|---:|---|
| `auditPage`, 2,000,000-character ASCII HTML with small extracted content | 2,000,322 | Yes |
| `auditPage`, combined field caps with ASCII content | 6,142,650 | Yes |
| `auditPage`, combined field caps with four-byte Unicode content | 19,642,299 | Yes |
| `auditPage`, combined field caps with JSON-escaped control characters | 28,642,065 | No |
| `auditPage`, small page with one llms.txt issue whose message alone is 25,165,824 ASCII characters | 25,166,588 | No |
| `checkCrawlerAccess`, 500,000-character robots.txt with a four-byte Unicode comment | 1,999,924 | Yes |
| `checkCrawlerAccess`, 500,000-character robots.txt with a JSON-escaped control-character comment | 2,999,794 | Yes |
| `checkCrawlerAccess`, missing-file result with an extra nested property containing 3,145,728 ASCII characters | 3,145,854 | No |

The combined audit fixtures use 2,000,000 HTML characters, 1,000,000
characters each of extracted text and Markdown, 200 headers with 8,192-character
ASCII values, a 500,000-character robots.txt result, and a short llms.txt
validation result containing one warning. The control-character fixtures use
`U+0001`, which takes six bytes per character when JSON-escaped. They test
schema and wire-size boundaries.

## Decision

Retain both OpenAPI request schemas. During scaffolding, set tool-wide
`BODY_LIMIT_BYTES=25165824` (24 MiB) for `auditPage` (`POST /v1/audits`).
Set a route-level Fastify `bodyLimit` of 3,145,728 bytes (3 MiB) for public
`checkCrawlerAccess` (`POST /v1/crawler-checks`). Each endpoint accepts
schema-valid requests at its exact serialized byte ceiling and returns
HTTP 413 one byte above it.

## Consequences

The ceilings admit the measured combined Unicode audit and the full-size
robots.txt fixtures. Schema-valid requests can still exceed them. Header
names, llms.txt finding counts and text, and extra fields inside shared
request objects can grow beyond a finite byte limit.
[Shared schemas](../../packages/contracts/openapi/common.yaml).

Scaffolding CI will measure the warmed request validator, including defaults,
on separate representative, intermediate, and exact-limit workloads for
each operation. Under [ADR 0027](0027-scale-typescript-validation-budget.md),
the audit validation gate requires **p99 below 120 ms** (`5 × 24`).
The public crawler-check validation gate is stricter at **p99 below 15 ms**
(`5 × 3`). Both gates exclude startup, JSON parsing, handler work, and
response serialization and fail at or above their threshold without retries.
Scaffolding CI will verify that schema-valid bodies
at each ceiling reach their benchmark handler and that adding one byte
returns HTTP 413. The public route's separate end-to-end target remains
**p99 under 2 seconds**.

## Alternatives considered

- **Keep 1 MiB and narrow the tool's schemas.** Reducing the HTML and
  robots.txt caps and bounding nested data would exclude legitimate inputs
  such as the ASCII HTML and multibyte robots.txt fixtures above.
- **Use 24 MiB for both routes.** This would simplify configuration and
  allow the public route to read larger bodies than its fetched-file
  workloads need. [ADR 0029](0029-llms-txt-generator-body-limit.md) uses a
  single ceiling across the llms.txt tool's operations.
