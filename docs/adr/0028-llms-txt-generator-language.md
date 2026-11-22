# 0028: Use TypeScript for llms-txt-generator

- **Status:** Proposed
- **Date:** 2026-11-23
- **Deciders:** Jay Pascual
- **Tool:** `llms-txt-generator`
- **Language:** `ts`

## Context

`llms-txt-generator` is the second tool in the [Phase 2 roadmap](../roadmap.md#phase-2-tool-services-one-at-a-time-each-built-and-tested-in-isolation).
Its [OpenAPI contract](../../packages/contracts/openapi/services/llms-txt-generator.yaml)
defines validation of supplied files, assembly of Markdown from supplied entries,
and page descriptions from extracted metadata and content. The extractive method
uses the meta description or the first paragraph, trimmed. These are Markdown and
text operations that fit TypeScript and the npm ecosystem, as
[ADR 0024](0024-per-tool-language.md) proposes. The existing TypeScript template
provides Fastify request validation from the vendored spec, contract tests, a
standalone Docker build, and an LLM adapter with offline test fixtures.

## Decision

Use TypeScript and the existing `services/_template`. Implement the operations in
the roadmap's Phase 2 order.

1. Implement `validateLlmsTxt` first. Validate inline content or a fetched-file
   result supplied in the request.
2. Implement deterministic `generateLlmsTxt` assembly of `llms.txt` and optional
   `llms-full.txt`, then add extractive page descriptions in `describePage`.
3. Add LLM-assisted page descriptions last, only in `describePage`, through the
   tool's `src/llm/` adapter.

Page discovery and extraction stay upstream. The tool takes extracted content,
entries, and files in its requests. Only the LLM-assisted mode calls a provider.
[ADR 0017](0017-deterministic-first-analysis.md), [ADR 0023](0023-llms-txt-pipeline.md).

## Consequences

Keep `language: ts` in the vendoring manifest. Jay must accept this ADR before
`scripts/new-tool llms-txt-generator --lang ts --llm` can run. The tool uses
the template's contract and standalone portability checks. Its per-tool CI gate
measures request-validation overhead against **5 ms p99 per MiB of the effective
request body limit** for representative, intermediate, and exact-limit workloads.
[ADR 0027](0027-scale-typescript-validation-budget.md).

## Alternatives considered

- **Python.** It can handle Markdown and offers NLP libraries. The specified
  extractive rule is simple text selection, so bringing forward the Python
  template and validation spike would add setup without a needed capability.
- **Go.** It can handle Markdown and assembly. The contracted text operations
  fit the existing TypeScript template, so Go would add a toolchain and bring
  forward its validation spike without a clear benefit for this tool.
