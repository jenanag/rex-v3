# 0024: Per-tool implementation language (TypeScript, Python or Go)

- **Status:** Accepted (2026-11-22, accepted by Jay)
- **Date:** 2026-11-22
- **Deciders:** Jay Pascual
- **Amends:** [0001](0001-monorepo-pnpm-turborepo.md), [0002](0002-typescript-fastify.md),
  [0006](0006-contract-first-openapi.md), [0007](0007-dry-policy.md),
  [0018](0018-tool-portability.md), [0019](0019-internal-packages.md) (each by a dated
  "Amended by" line; their text is not rewritten)
- **Edited before acceptance:** 2026-11-22, Jay's decisions at acceptance, written into
  this ADR directly (it was still Proposed): engine-query stays TypeScript and Go starts
  with ai-traffic-analyzer (Phase 7); uv, openapi-core with FastAPI, kin-openapi and the
  validation budgets approved; spikes right before each tool's step; one language ADR
  per tool, TypeScript tools included
- **Amended by:** [0026](0026-typescript-validation-budget.md), 2026-11-22 (accepted by Jay). Applies to the TypeScript validation budget scope.

## Context

Phase 0 assumed every tool is a TypeScript npm project ([ADR 0002](0002-typescript-fastify.md),
[ADR 0018](0018-tool-portability.md)). Some tools fit other ecosystems better:
answer-analysis (deterministic sentiment, NLP, multilingual lexicons, embeddings) and
the later entity-optimizer and query-discovery are best served by Python's libraries;
high-throughput, CPU-heavy work (the later ai-traffic-analyzer parsing large logs)
suits Go, which Jay's external extractors already use. Tools are
request-in, response-out services behind a vendored contract, called only over HTTP
([ADR 0009](0009-stateless-tool-services.md)), so the contract, not the language, is
what callers depend on. Jay approved revising Phase 1 for this ("yes, revise phase 1").

## Decision

**Decided by Jay:** the tool factory becomes multi-language. A tool may be written in
TypeScript (`ts`), Python (`python`) or Go (`go`); the platform (gateway, orchestrator,
workers, apps) stays TypeScript ([ADR 0002](0002-typescript-fastify.md)). Contract
first and the portability check stay language-neutral. `_template-python` and
`_template-go` are added only when the first tool in that language is scheduled, and
each tool's language is chosen in its own small ADR at the start of its Phase 2 step.
At acceptance Jay also decided:

- **engine-query stays TypeScript.** Its contract is one prompt to one engine per call
  and the fan-out across engines is in workers, so Go would gain little there. Go
  starts with ai-traffic-analyzer in Phase 7; Phase 2 needs only the Python bring-up.
- **Toolchain choices approved:** uv (`uv.lock`) for Python projects; openapi-core with
  FastAPI as the Python request validator; kin-openapi as the Go request validator;
  p99 validation overhead budgets of 5 ms for Python and 1 ms for TypeScript and Go.
- **Spikes are gates and run right before each tool's step:** a language's spike runs
  just before the first tool in that language and must pass before that tool starts.
- **One language ADR per tool, TypeScript tools included:** written at the start of
  each tool's step and accepted by Jay before the tool is scaffolded.

**Design (accepted by Jay, 2026-11-22):**

- **The contract is the boundary.** Every tool serves its vendored, bundled
  `contract/openapi.yaml`, whatever its language. Callers generate TypeScript clients
  from the same vendored specs as before; nothing outside the tool knows its language.
- **One field says which language.** `language: ts | python | go` on each tool in
  [vendoring.yaml](../../packages/contracts/vendoring.yaml); its `languages` map names
  the template and the type generator per language, so `scripts/vendor-contracts`
  writes the right generated types (types only: the spec stays the validator).
- **The tool rules do not change with the language.** Every tool, in every language:
  validates requests from the vendored spec (JSON Schema 2020-12; unknown fields give
  400; no type coercion of JSON bodies; defaults applied first, as the cache key rule
  expects); answers errors as RFC 9457 `application/problem+json` with the shared
  `Problem` and `validation_failed` pointers ([conventions §4](../conventions.md#4-errors));
  serves `/healthz` and `/readyz`; reads config from environment variables; logs and
  traces with the standard fields ([conventions §11](../conventions.md#11-logging-tracing-and-metrics));
  calls LLMs only through its LLM adapter with `LLM_MODE=live|mock|record`, usage mapped
  to `LlmUsage`, the same fixture format and SDK retries off; has no network besides LLM
  APIs (never fetches, [ADR 0021](0021-content-extraction.md)), no auth, no cache, no
  bus and never retries; is a self-contained folder with a committed lockfile, exact
  versions from the public registry of its language, a Dockerfile and a green
  portability job.
- **Per-language equivalents** (public, well-known packages; the runtime package list
  itself stays in [conventions §16](../conventions.md#approved-tool-dependencies), the
  single source):

| Rule | TypeScript (`ts`) | Python (`python`) | Go (`go`) |
|---|---|---|---|
| HTTP server | Fastify 5 | FastAPI on uvicorn | standard library `net/http` |
| Request validation from the vendored 3.1 spec | Ajv (2020-12) through the route loader chosen by the spike (ADR 0020) | openapi-core (`V31RequestValidator`, FastAPI middleware); FastAPI's own pydantic validation is not the validator; the Python spike is the gate | kin-openapi `openapi3filter` with JSON Schema 2020-12 validation (3.1 support is new); the Go spike is the gate |
| Generated types (never the validator) | openapi-typescript, `contract/types.ts` | datamodel-code-generator (pydantic v2 models), `contract/models.py` | oapi-codegen types plus embedded spec, `contract/types.gen.go` |
| RFC 9457 errors, health probes | template `errors.ts`, probes | template exception handlers, probes | template `problem` package, probes |
| Config from env | env-schema | pydantic-settings | caarlos0/env |
| Logs and traces | pino, OpenTelemetry Node SDK | structlog, OpenTelemetry Python SDK | `log/slog`, OpenTelemetry Go SDK |
| LLM adapter (`LLM_MODE`) | official SDKs: openai, @anthropic-ai/sdk, @google/genai | official SDKs: openai, anthropic, google-genai | official SDKs: openai-go, anthropic-sdk-go, google.golang.org/genai |
| Manifest and lockfile | `package.json` + `package-lock.json` (npm) | `pyproject.toml` (`==` pins) + `uv.lock` (uv) | `go.mod` (no `replace`) + `go.sum` |
| Tests, contract tests | vitest; responses checked with Ajv | pytest; responses checked with openapi-core | `go test`; responses checked with kin-openapi |
| Lint, format, types | ESLint, Prettier, `tsc` | ruff (lint and format), mypy (strict) | golangci-lint (gofmt, govet) |
| Dependency boundary | dependency-cruiser | import-linter + manifest lint | `go vet` + golangci-lint depguard + `go.mod` lint |
| Container | multi-stage, non-root, Node slim base, `HEALTHCHECK` | multi-stage, non-root, Python slim base with uv, `HEALTHCHECK` | multi-stage, non-root, distroless static base, `HEALTHCHECK` through the binary's own health subcommand |
| Duplication | jscpd (all languages, one run) | jscpd | jscpd |

- **Spikes before the first tool in a language.** The TypeScript spike stays ADR 0020
  (Phase 1). A Python spike (confirms openapi-core with FastAPI; a 60-line route loader
  over `jsonschema`'s 2020-12 validator is the fallback only if it fails) runs right
  before answer-analysis, and a Go spike (confirms kin-openapi; libopenapi-validator
  is the fallback only if it fails) runs right before ai-traffic-analyzer
  ([roadmap 1.3](../roadmap.md#13-spikes-request-validation-from-the-vendored-31-spec)).
  Each is time-boxed, records its result in a short ADR and gates its first tool; if a
  spike fails and no fallback works, that tool stays TypeScript.
- **Language per tool** (each one needs its own tool ADR at the start of the tool's
  Phase 2 step, or its phase for later tools, accepted by Jay; until then `language`
  stays `ts`; "Decided by Jay" marks his decision at acceptance):

| Tool | Phase | Language | Why |
|---|---|---|---|
| `schema-generator` | 2 | TypeScript (Proposed) | JSON-LD processing, where jsonld.js is the reference implementation, and HTML parsing; the TypeScript template is hardened here first |
| `llms-txt-generator` | 2 | TypeScript (Proposed) | Markdown handling and an extractive summarizer; no library need outside npm |
| `content-auditor` | 2 | TypeScript (Proposed) | HTML parsing and robots.txt rules with the approved npm packages |
| `citation-extractor` | 2 | TypeScript (Proposed) | Markdown lexer for inline links; small, no library need outside npm |
| `answer-analysis` | 2 | Python (Proposed) | deterministic sentiment, NLP, multilingual lexicons and embeddings have their mature libraries in Python |
| `engine-query` | 2 | TypeScript (Decided by Jay) | one prompt to one engine per call, the fan-out across engines stays in workers, so Go would gain little; the official npm SDKs cover the engines |
| `notifier` | 6 | TypeScript (Proposed) | delivery over email and webhooks; no library need outside npm |
| `report-renderer` | 6 | TypeScript (Proposed) | HTML and PDF rendering, best supported by the Node headless-browser tooling |
| `query-discovery` | 7 | Python (Proposed) | clustering, embeddings and relevance scoring |
| `content-rewriter` | 7 | TypeScript (Proposed) | LLM-call bound; no library need outside npm |
| `entity-optimizer` | 7 | Python (Proposed) | entity matching and knowledge-graph data (Wikidata) tooling |
| `ai-traffic-analyzer` | 7 | Go (Proposed) | parsing large log batches fast with low memory |

## Consequences

- Each tool can use the ecosystem that fits its work; callers, caching, the bus and the
  gateway do not change, because they only see the contract.
- More templates, toolchains and CI lanes to keep healthy: three ways to do bootstrap,
  errors and the LLM adapter. Mitigated by adding a language only when a tool needs it,
  by one language-neutral portability job and by template drift checks per template.
- The generated types of a tool change when its language changes (its tool ADR switches
  `language` and re-vendors); the vendored `openapi.yaml` does not.
- Python and Go validation of OpenAPI 3.1 is less proven than Ajv; the spikes (gates
  right before the first tool in each language) and the TypeScript fallback keep that
  risk off the critical path. Phase 2 brings up only Python; Go waits for Phase 7.
- Shared fixture format and rules mean an LLM fixture or a contract test case means the
  same thing in every language.

## Alternatives considered

- **TypeScript only** (Phase 0 design): one toolchain, but the NLP and embedding work
  would rely on thinner npm libraries or on calling LLMs for what deterministic Python
  code does well.
- **Any language per tool**: maximal freedom, but every new language multiplies
  templates, CI lanes and review knowledge; three is the set with a clear use.
- **All three templates in Phase 1**: earlier certainty, but two templates nobody uses
  for months would drift; the spikes run just before they are needed instead.
- **FastAPI's code-first OpenAPI or Go server generation from the spec as the validator**:
  breaks contract first (the vendored spec must be the validator, not generated code or
  pydantic models).
