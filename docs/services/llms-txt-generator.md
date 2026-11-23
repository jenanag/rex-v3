# llms-txt-generator

- **Kind:** tool ([what that means](../architecture.md#service-map))
- **Phase:** 2
- **Contract:** source [packages/contracts/openapi/services/llms-txt-generator.yaml](../../packages/contracts/openapi/services/llms-txt-generator.yaml); vendored, self-contained copy in [services/llms-txt-generator/contract/](../../services/llms-txt-generator/contract/openapi.yaml) ([ADR 0018](../adr/0018-tool-portability.md))
- **Language:** TypeScript (`language: ts` in vendoring.yaml), per [ADR 0028](../adr/0028-llms-txt-generator-language.md), accepted by Jay on 2026-11-23.
- **Portability:** a self-contained project in its language: copy `services/llms-txt-generator/` anywhere, then its install, build, test and `docker build` work with nothing else present; no auth, no cache, no bus inside ([ADR 0018](../adr/0018-tool-portability.md))
- **State:** none (callers cache its results, see below)
- **Bus:** none

## Purpose

Writes one page's entry, assembles the site's llms.txt files and validates existing
files using content supplied by the caller ([ADR 0023](../adr/0023-llms-txt-pipeline.md)).

- `describePage` keeps title selection and the supplied URL deterministic.
  Explicit `extractive` uses the contract's offline description fallbacks and returns
  empty usage. Default `llm` can make one Chat Completions call for the description,
  using a prompt capped at 16,384 serialized UTF-8 bytes. With no usable description
  source it skips the call. Unusable output falls back to the extractive result while
  preserving the call's usage. The sole initial allowed model and the default for
  `LLMS_TXT_GENERATOR_DEFAULT_MODEL` are `openai/gpt-6-luna`.
  [ADR 0017](../adr/0017-deterministic-first-analysis.md).
- `generateLlmsTxt` assembles `llms.txt` (and optionally `llms-full.txt`) from the
  entries in input order. The full file quotes supplied page Markdown and truncates
  at a page boundary with a closing notice. See the source contract for formatting
  and fallback rules.
- `validateLlmsTxt` checks supplied CommonMark against [llms.txt v2](https://llmstxt.org/#format)
  and returns line-based findings. It validates inline text or a supplied fetch result
  offline. Relative list links resolve against a fetched file's URL and produce warnings
  for inline content. Missing and invalid files return HTTP 200 with findings.

It never crawls or fetches: the orchestrator's pipeline discovers the pages through the
sitemap-extractor and extracts them through the content-extractor
([ADR 0021](../adr/0021-content-extraction.md)).

## Endpoints

<!-- GENERATED:endpoints START (source: packages/contracts/openapi/services/llms-txt-generator.yaml) -->
- `POST /v1/llms-txt/page-entries`: `describePage`
- `POST /v1/llms-txt`: `generateLlmsTxt`
- `POST /v1/llms-txt/validate`: `validateLlmsTxt` (public via gateway at `/v1/tools/llms-txt/validate`)
- `GET /healthz`, `GET /readyz`: shared probes
<!-- GENERATED:endpoints END -->

## Caching (by callers)

<!-- GENERATED:cache START (source: packages/contracts/cache/policy.yaml) -->
Caller cache policy: [policy.yaml](../../packages/contracts/cache/policy.yaml) ([ADR 0016](../adr/0016-cache-first.md)).

keyVersion `5`. The values below are defaults; scope and freshness can be overridden per environment and per customer (policy.yaml `resolution`).

| Operation | Kept for | Scope | Notes |
| --- | --- | --- | --- |
| `describePage` | `P30D` | shared | read back by reference |
| `generateLlmsTxt` | `P30D` | shared |  |
| `validateLlmsTxt` | `P30D` | shared |  |
<!-- GENERATED:cache END -->

## Limits

<!-- GENERATED:limits START (source: x-rex-limits in packages/contracts/openapi/services/llms-txt-generator.yaml) -->
See [the tool's operation limits](../../services/llms-txt-generator/AGENTS.md#limits).
<!-- GENERATED:limits END -->

The scaffold defaults `BODY_LIMIT_BYTES` to `12582912` (12 MiB) through the tool's
configuration loader. The ceiling applies to all routes, including public
validation, and requests above it receive HTTP 413. The current OpenAPI request
schemas still apply.
[ADR 0029](../adr/0029-llms-txt-generator-body-limit.md).

### Request validation benchmark

From `services/llms-txt-generator/`, using the Node version in the root `.nvmrc`:

```sh
npm ci
npm run build
node scripts/benchmark-validation.mjs
```

The benchmark uses the scaffold's Fastify application and needs no running server,
network, or credentials. The shared tool workflow runs it offline. It checks the
12 MiB effective limit and fails if any workload reaches 60 ms p99 for the warmed
validator. It checks that each exact-limit request reaches its handler and that
adding one byte returns HTTP 413. All three operations use benchmark-only
handlers so their content work stays outside the benchmark. Exact-limit fixtures exercise
bounded content fields at their schema maxima and use trailing JSON whitespace
where needed.
[ADR 0027](../adr/0027-scale-typescript-validation-budget.md).

### Page-entry smoke check

From `services/llms-txt-generator/`, use the repo-pinned Node version and run
`npm ci`, `npm run build`, and `node scripts/smoke-describe-page.mjs`. The script
starts and stops a standalone service in `LLM_MODE=mock` and checks both
`describePage` modes over loopback. The committed mock completion and token counts
are synthetic. Usage pricing comes from the tool-local catalog and uses
[published OpenAI standard rates](https://developers.openai.com/api/docs/models/gpt-6-luna#pricing).

## Shared schemas

<!-- GENERATED:shared START (source: packages/contracts/openapi/services/llms-txt-generator.yaml + common.yaml) -->
- [`Healthz`](../../packages/contracts/openapi/common.yaml) (pathItems); also used by answer-analysis, citation-extractor, content-auditor, content-extractor, engine-query, gateway, orchestrator, schema-generator, sitemap-extractor.
- [`Readyz`](../../packages/contracts/openapi/common.yaml) (pathItems); also used by answer-analysis, citation-extractor, content-auditor, content-extractor, engine-query, gateway, orchestrator, schema-generator, sitemap-extractor.
- [`BadRequest`](../../packages/contracts/openapi/common.yaml) (responses); also used by answer-analysis, citation-extractor, content-auditor, content-extractor, engine-query, orchestrator, schema-generator, sitemap-extractor.
- [`InternalError`](../../packages/contracts/openapi/common.yaml) (responses); also used by answer-analysis, citation-extractor, content-auditor, content-extractor, engine-query, orchestrator, schema-generator, sitemap-extractor.
- [`ServiceUnavailable`](../../packages/contracts/openapi/common.yaml) (responses); also used by answer-analysis, content-auditor, content-extractor, engine-query, sitemap-extractor.
- [`UnprocessableContent`](../../packages/contracts/openapi/common.yaml) (responses); also used by answer-analysis, content-auditor, content-extractor, engine-query, orchestrator, schema-generator, sitemap-extractor.
- [`ExtractedContent`](../../packages/contracts/openapi/common.yaml) (schemas); also used by content-auditor, content-extractor.
- [`FetchedFile`](../../packages/contracts/openapi/common.yaml) (schemas); also used by content-auditor, content-extractor, sitemap-extractor.
- [`LlmUsageList`](../../packages/contracts/openapi/common.yaml) (schemas); also used by answer-analysis, engine-query.
- [`LlmsTxtValidation`](../../packages/contracts/openapi/common.yaml) (schemas); also used by content-auditor.
- [`PageMetadata`](../../packages/contracts/openapi/common.yaml) (schemas); also used by content-extractor.
- [`Url`](../../packages/contracts/openapi/common.yaml) (schemas); also used by citation-extractor, content-auditor, content-extractor, orchestrator, schema-generator, sitemap-extractor.
<!-- GENERATED:shared END -->

## Used by

- Worker flow `page-audit` (`describePage`, one page per job), worker flow
  `llms-txt-generation` (`generateLlmsTxt` with entries read back from the cache, else
  the data-aggregator), worker flow `content-audit` (validation of the site's /llms.txt
  from the extraction).
- Gateway public route for validation (file content pasted by the user).

## Dependencies

- LLM API through its LLM adapter, only in `describePage` with `summarizer: llm`; tests use
  `LLM_MODE=mock`. No other network.
<!-- GENERATED:deps START (source: docs/conventions.md#approved-tool-dependencies) -->
- `fastify`: HTTP server
- `@fastify/sensible`: HTTP errors and helpers
- `@fastify/under-pressure`: load shedding, readiness
- `ajv`: JSON Schema 2020-12 validation
- `ajv-formats`: formats for Ajv
- `env-schema`: config from env
- `pino`: logs (Fastify's logger)
- `@opentelemetry/sdk-node`: traces and metrics
- `@opentelemetry/auto-instrumentations-node`: HTTP instrumentation (including Node's built-in fetch used by the LLM SDKs)
- `openai`: LLM SDK (also Perplexity and xAI via `baseURL`) (`--llm`)
- `@anthropic-ai/sdk`: LLM SDK (`--llm`)
- `@google/genai`: LLM SDK (`--llm`)
- `mdast-util-from-markdown`: CommonMark parsing for llms.txt validation and extractive page descriptions
<!-- GENERATED:deps END -->

## Notes

- `fullContent` is capped at 2,000,000 characters (Unicode code points), including
  formatting and any truncation notice. This output character cap is separate from
  the bus message byte limit. The worker limits the page Markdown it supplies as
  described in [ADR 0023](../adr/0023-llms-txt-pipeline.md).
