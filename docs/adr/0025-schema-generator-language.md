# 0025: Use TypeScript for schema-generator

- **Status:** Proposed
- **Date:** 2026-11-22
- **Deciders:** Jay Pascual
- **Tool:** `schema-generator`
- **Language:** `ts`

## Context

`schema-generator` is the first Phase 2 tool. It generates and validates
schema.org JSON-LD from the structured input, HTML, or JSON-LD supplied in a
request. Its work is deterministic and stays offline. [Phase 2 order](../roadmap.md#phase-2-tool-services-one-at-a-time-each-built-and-tested-in-isolation),
[service contract](../../packages/contracts/openapi/services/schema-generator.yaml).

[ADR 0024](0024-per-tool-language.md) proposes TypeScript for JSON-LD processing,
where jsonld.js is the reference implementation, and HTML parsing; the TypeScript
template is hardened here first.
[Approved dependencies](../conventions.md#approved-tool-dependencies).

## Decision

Implement `schema-generator` in TypeScript using `services/_template` without
the LLM adapter. Use `cheerio` to parse supplied HTML and `jsonld` (jsonld.js) to
expand JSON-LD; validation rules run on the expanded form.
Resolve `@context` only from a schema.org context file vendored in the tool, through
a custom jsonld `documentLoader`; any other remote context is rejected, never fetched.
The vendored OpenAPI contract remains the request validator through the Fastify
loader and Ajv2020. [ADR 0020](0020-fastify-openapi-validation.md).

## Consequences

Keep `language: ts` in the vendoring manifest. After Jay accepts this ADR, scaffold
the tool with `scripts/new-tool schema-generator --lang ts` and verify its contract,
deterministic behavior, and standalone portability. This first implementation
exercises the existing TypeScript template against a real tool contract.
[Vendoring manifest](../../packages/contracts/vendoring.yaml).

Its contract allows `html` up to 2,000,000 characters, above the template's
default 1 MiB body limit ([ADR 0020](0020-fastify-openapi-validation.md)).
Before scaffolding, Jay sets schema-generator's `BODY_LIMIT_BYTES` or narrows
the contract ([ADR 0026](0026-typescript-validation-budget.md)).

## Alternatives considered

- **Python.** The task has no NLP or other Python-specific dependency. This choice
  would bring the Python template and validation spike forward.
- **Go.** A second toolchain and validation spike would be needed for the first
  tool. The approved TypeScript dependencies already cover its parsing and
  validation requirements.
