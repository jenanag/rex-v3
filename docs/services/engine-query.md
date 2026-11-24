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

keyVersion `2`. The values below are defaults; scope and freshness can be overridden per environment and per customer (policy.yaml `resolution`).

| Operation | Kept for | Scope | Notes |
| --- | --- | --- | --- |
| `listEngines` | `PT5M` | shared |  |
| `queryEngine` | `P1D` | shared | window, extra key inputs `engineModel` |
<!-- GENERATED:cache END -->

## Limits

<!-- GENERATED:limits START (source: x-rex-limits in packages/contracts/openapi/services/engine-query.yaml) -->
See [the tool's operation limits](../../services/engine-query/AGENTS.md#limits).
<!-- GENERATED:limits END -->

The tool uses Fastify's default **1,048,576-byte** request body limit when
`BODY_LIMIT_BYTES` is unset. The validator benchmark runs a representative, a full
prompt, and an exact-limit request against the strict **p99 < 5 ms** gate.
At the limit, the Perplexity request reaches the handler and returns HTTP 422
`unsupported_engine`. One extra byte returns HTTP 413
`payload_too_large`. To run the benchmark from the tool folder, run
`npm run build` and then `node scripts/benchmark-validation.mjs` with
`BODY_LIMIT_BYTES` unset.

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

## Direct smoke check

From the tool folder, use the Node version in `.nvmrc` and build and start the
standalone service:

```sh
npm ci
npm run build
env -i PATH="$PATH" LLM_MODE=mock PORT=8080 node dist/src/server.js
```

In another terminal in the same folder, run `node scripts/smoke-engine-query.mjs`.
Set `PORT` for both commands if you use a port other than 8080. The service starts
with provider credentials unset and replays the committed Parks Canada fixture
without provider traffic. The script checks discovery and the recorded answer,
source, and usage over loopback HTTP.

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
- `mdast-util-from-markdown`: CommonMark source positions for citation placement
<!-- GENERATED:deps END -->

## Notes

- [ADR 0038](../adr/0038-engine-query-selectable-web-search.md) proposes selectable
  web search and a text-only Gemini integration, pending Jay's acceptance.
- The first integration uses OpenAI GPT-6 Luna through Responses. Discovery lists
  ChatGPT. Each query uses one required provider-hosted search and reports one
  usage item at Standard rates, including the reported billable search fee.
  [OpenAI pricing](https://developers.openai.com/api/docs/pricing#tools).
- Provider failures return 503. The tool converts a valid upstream `Retry-After`
  to seconds. The worker owns retries.
- The caller key includes the original prompt, effective locale and country, and
  the configured model from discovery (`engineModel`), per UTC day and sample.
  Refresh discovery on rollout and verify the returned model before storage. A
  search configuration change under the same model requires a key version bump.
- API answers can differ from the consumer apps; AI Overviews needs a SERP provider
  ([deferred decision](../roadmap.md#deferred-decisions)).
