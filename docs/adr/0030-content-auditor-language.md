# 0030: Use TypeScript for content-auditor

- **Status:** Proposed
- **Date:** 2026-11-24
- **Deciders:** Jay Pascual
- **Tool:** `content-auditor`
- **Language:** `ts`

## Context

`content-auditor` is the third tool in the [Phase 2 roadmap](../roadmap.md#phase-2-tool-services-one-at-a-time-each-built-and-tested-in-isolation).
Its [OpenAPI contract](../../packages/contracts/openapi/services/content-auditor.yaml)
defines `auditPage` for caller-supplied page data and `checkCrawlerAccess` for a
caller-supplied robots.txt result. Both operations run offline without an LLM.
[ADR 0024](0024-per-tool-language.md) proposes TypeScript because the approved npm
packages cover HTML parsing and robots.txt evaluation. The existing TypeScript
template provides Fastify validation from the vendored OpenAPI spec, contract tests,
and a standalone Docker build.

## Decision

Use TypeScript and the existing `services/_template`.

1. After Jay accepts this ADR, scaffold with
   `scripts/new-tool content-auditor --lang ts`.
2. Implement `auditPage`. Use approved `cheerio` to inspect the supplied HTML and
   evaluate the audit using the supplied extracted content, raw response, and any
   robots.txt result and llms.txt validation in the request.
3. Implement `checkCrawlerAccess`. Use approved `robots-parser` to evaluate the
   supplied robots.txt rules against the crawler tokens in the vendored
   `contract/ai-crawlers.yaml`. Use the same rules and crawler list for the
   robots.txt checks in `auditPage`.

The crawler list ships with the tool. Callers supply all page and file data.
[Approved tool dependencies](../conventions.md#approved-tool-dependencies),
[crawler data source](../../packages/contracts/data/ai-crawlers.yaml),
[ADR 0021](0021-content-extraction.md).

## Consequences

Keep `language: ts` in the vendoring manifest. Reuse the template's contract tests
and standalone portability checks, with offline fixtures for both operations.
The TypeScript per-tool CI gate measures validation overhead at **5 ms p99 per
MiB of the effective request body limit**. [ADR 0027](0027-scale-typescript-validation-budget.md).

## Alternatives considered

- **Python.** It can parse HTML and evaluate robots.txt. This tool would bring
  forward the Python validation spike and template for operations already covered
  by the approved npm packages.
- **Go.** It can perform both checks offline. Choosing it would bring forward
  the Go validation spike and template. The contracted HTML and robots.txt checks
  fit the existing TypeScript stack.
