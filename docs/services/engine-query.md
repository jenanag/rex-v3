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

keyVersion `5`. The values below are defaults; scope and freshness can be overridden per environment and per customer (policy.yaml `resolution`).

| Operation | Kept for | Scope | Notes |
| --- | --- | --- | --- |
| `listEngines` | `PT5M` | shared |  |
| `queryEngine` | `P1D` | shared | window |
<!-- GENERATED:cache END -->

## Limits

<!-- GENERATED:limits START (source: x-rex-limits in packages/contracts/openapi/services/engine-query.yaml) -->
See [the tool's operation limits](../../services/engine-query/AGENTS.md#limits).
<!-- GENERATED:limits END -->

The tool uses Fastify's default **1,048,576-byte** request body limit when
`BODY_LIMIT_BYTES` is unset. The validator benchmark runs a representative, a full
prompt, and an exact-limit request against the strict **p99 < 5 ms** gate.
At the limit, the unsupported pair reaches the handler and returns HTTP 422
`unsupported_model`. One extra byte returns HTTP 413
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
- [`LlmUsageList`](../../packages/contracts/openapi/common.yaml) (schemas); also used by answer-analysis, llms-txt-generator.
- [`Locale`](../../packages/contracts/openapi/common.yaml) (schemas); also used by orchestrator.
- [`ProviderModel`](../../packages/contracts/openapi/common.yaml) (schemas); also used by answer-analysis, llms-txt-generator.
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

- [ADR 0041](../adr/0041-standardize-tool-provider-model-selection.md) uses
  explicit provider and model pairs for tool selection. Discovery lists
  supported pairs and their search capability. Tracking engine labels belong to
  the platform. An unsupported exact pair returns HTTP 422 before a provider call.
- OpenAI GPT-6 Luna supports hosted search through the Responses API.
  Requests explicitly choose whether web search is required. Text-only answers
  incur zero search fees. Gemini only supports text-only generation and rejects
  search-on requests before any provider call. See the
  [deferred decision on opt-in Gemini web search](../roadmap.md#opt-in-gemini-web-search).
- Gemini uses `gemini-3.5-flash-lite` on the Gemini Developer API v1. Its Standard
  text rates are $0.30 uncached input, $0.03 cached input, and $2.50 output including
  thinking per million tokens. Text-only answers return an empty source list.
  [Gemini pricing](https://aistudio.google.com/docs/pricing#gemini-3.5-flash-lite).
- Provider failures return 503. The tool converts a valid upstream `Retry-After`
  to seconds. The worker owns retries.
- Validate the explicit pair and search mode before lookup as defined by the
  [caller cache policy](../../packages/contracts/cache/policy.yaml).
  Refresh discovery on rollout and verify the returned model before storage.
  The orchestrator owns future subscription eligibility in
  [Phase 6](../roadmap.md#phase-6-monetization).
- API answers can differ from the consumer apps; AI Overviews needs a SERP provider
  ([deferred decision](../roadmap.md#deferred-decisions)).
