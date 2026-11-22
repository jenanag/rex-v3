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
files. Each operation is a pure function of its input
([ADR 0023](../adr/0023-llms-txt-pipeline.md)).

- `describePage` writes one page's llms.txt entry (title and description) from its
  extracted content and metadata. Descriptions are `extractive` (deterministic: meta
  description or first paragraph, no LLM) or `llm` (model selectable), per
  [ADR 0017](../adr/0017-deterministic-first-analysis.md). This is the only LLM use.
- `generateLlmsTxt` assembles `llms.txt` (and optionally `llms-full.txt`) from the
  entries, deterministically and without any LLM call.
- `validateLlmsTxt` checks an existing llms.txt against the format.

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

keyVersion `1`. The values below are defaults; scope and freshness can be overridden per environment and per customer (policy.yaml `resolution`).

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

Jay accepted the tool-wide 12 MiB (12,582,912 bytes) Fastify request body ceiling
on 2026-11-23. It applies to public validation and retains the current OpenAPI
request schemas. Scaffolding will set `BODY_LIMIT_BYTES=12582912` and verify the
60 ms validator-only p99 target in CI with valid bodies at the exact limit.
[ADR 0029](../adr/0029-llms-txt-generator-body-limit.md).

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
<!-- GENERATED:deps END -->

## Notes

- `fullContent` is capped at 2 MB so results stay within the bus message limit; the
  worker sends page Markdown only up to that size.
