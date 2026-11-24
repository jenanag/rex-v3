# engine-query

- **Kind:** tool ([what that means](../architecture.md#service-map))
- **Phase:** 2
- **Contract:** source [packages/contracts/openapi/services/engine-query.yaml](../../packages/contracts/openapi/services/engine-query.yaml); vendored, self-contained copy in [services/engine-query/contract/](../../services/engine-query/contract/openapi.yaml) ([ADR 0018](../adr/0018-tool-portability.md))
- **Language:** TypeScript (`language: ts` in vendoring.yaml), as Jay decided in [ADR 0024](../adr/0024-per-tool-language.md). Jay accepted [ADR 0037](../adr/0037-engine-query-language.md) on 2026-11-24, confirming use of the existing TypeScript LLM template for scaffolding.
- **Portability:** a self-contained project in its language: copy `services/engine-query/` anywhere, then its install, build, test and `docker build` work with nothing else present; no auth, no cache, no bus inside ([ADR 0018](../adr/0018-tool-portability.md))
- **State:** none (callers cache its results, see below)
- **Bus:** none

## Purpose

Sends one prompt to one answer engine through its API (with web search or grounding
where the API supports it) and returns the answer text, the engine-reported sources and
LLM usage. Replaces the v1 prompt-tracker; runs, prompts and storage moved to the
orchestrator's `tracking` module.

## Endpoints

<!-- GENERATED:endpoints START (source: packages/contracts/openapi/services/engine-query.yaml) -->
- `GET /v1/engines`: `listEngines`
- `POST /v1/engine-answers`: `queryEngine`
- `GET /healthz`, `GET /readyz`: shared probes
<!-- GENERATED:endpoints END -->

## Caching (by callers)

<!-- GENERATED:cache START (source: packages/contracts/cache/policy.yaml) -->
Caller cache policy: [policy.yaml](../../packages/contracts/cache/policy.yaml) ([ADR 0016](../adr/0016-cache-first.md)).

keyVersion `1`. The values below are defaults; scope and freshness can be overridden per environment and per customer (policy.yaml `resolution`).

| Operation | Kept for | Scope | Notes |
| --- | --- | --- | --- |
| `listEngines` | `PT5M` | shared |  |
| `queryEngine` | `P1D` | shared | window, extra key inputs `engineModel`, normalization in [policy.yaml](../../packages/contracts/cache/policy.yaml) |
<!-- GENERATED:cache END -->

## Limits

<!-- GENERATED:limits START (source: x-rex-limits in packages/contracts/openapi/services/engine-query.yaml) -->
See [the tool's operation limits](../../services/engine-query/AGENTS.md#limits).
<!-- GENERATED:limits END -->

## Shared schemas

<!-- GENERATED:shared START (source: packages/contracts/openapi/services/engine-query.yaml + common.yaml) -->
- [`Healthz`](../../packages/contracts/openapi/common.yaml) (pathItems); also used by answer-analysis, citation-extractor, content-auditor, content-extractor, gateway, llms-txt-generator, orchestrator, schema-generator, sitemap-extractor.
- [`Readyz`](../../packages/contracts/openapi/common.yaml) (pathItems); also used by answer-analysis, citation-extractor, content-auditor, content-extractor, gateway, llms-txt-generator, orchestrator, schema-generator, sitemap-extractor.
- [`BadRequest`](../../packages/contracts/openapi/common.yaml) (responses); also used by answer-analysis, citation-extractor, content-auditor, content-extractor, llms-txt-generator, orchestrator, schema-generator, sitemap-extractor.
- [`InternalError`](../../packages/contracts/openapi/common.yaml) (responses); also used by answer-analysis, citation-extractor, content-auditor, content-extractor, llms-txt-generator, orchestrator, schema-generator, sitemap-extractor.
- [`ServiceUnavailable`](../../packages/contracts/openapi/common.yaml) (responses); also used by answer-analysis, content-auditor, content-extractor, llms-txt-generator, sitemap-extractor.
- [`UnprocessableContent`](../../packages/contracts/openapi/common.yaml) (responses); also used by answer-analysis, content-auditor, content-extractor, llms-txt-generator, orchestrator, schema-generator, sitemap-extractor.
- [`AnswerSource`](../../packages/contracts/openapi/common.yaml) (schemas); also used by citation-extractor.
- [`CountryCode`](../../packages/contracts/openapi/common.yaml) (schemas); also used by orchestrator.
- [`EngineId`](../../packages/contracts/openapi/common.yaml) (schemas); also used by orchestrator.
- [`LlmUsageList`](../../packages/contracts/openapi/common.yaml) (schemas); also used by answer-analysis, llms-txt-generator.
- [`Locale`](../../packages/contracts/openapi/common.yaml) (schemas); also used by orchestrator.
<!-- GENERATED:shared END -->

## Used by

- Worker flow `answer-capture` (first step).

## Dependencies

- Engine APIs through its LLM adapter over the official SDKs; tests use `LLM_MODE=mock`.
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

- A provider 429 or outage returns 503 with `Retry-After`; the worker retries later.
- Callers cache answers per UTC day and per sample (policy above), so the same prompt on
  the same engine, model and locale is asked once a day across all projects. Changing
  the engine-to-model mapping changes the key automatically (`engineModel`).
- API answers can differ from the consumer apps; AI Overviews needs a SERP provider
  ([deferred decision](../roadmap.md#deferred-decisions)).
