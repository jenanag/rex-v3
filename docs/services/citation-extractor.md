# citation-extractor

- **Kind:** tool ([what that means](../architecture.md#service-map))
- **Phase:** 2
- **Contract:** source [packages/contracts/openapi/services/citation-extractor.yaml](../../packages/contracts/openapi/services/citation-extractor.yaml); vendored, self-contained copy in [services/citation-extractor/contract/](../../services/citation-extractor/contract/openapi.yaml) ([ADR 0018](../adr/0018-tool-portability.md))
- **Language:** TypeScript (`language: ts` in vendoring.yaml), as [ADR 0024](../adr/0024-per-tool-language.md) proposes: Markdown lexer for inline links; small, no library need outside npm. Its own language ADR, accepted by Jay, confirms it at the start of its Phase 2 step.
- **Portability:** a self-contained project in its language: copy `services/citation-extractor/` anywhere, then its install, build, test and `docker build` work with nothing else present; no auth, no cache, no bus inside ([ADR 0018](../adr/0018-tool-portability.md))
- **State:** none (callers cache its results, see below)
- **Bus:** none

## Purpose

Turns an answer's sources and inline links into normalized citations (URL, domain,
source type) and classifies ownership (`own`, `competitor`, `third_party`) against the
tracked brands' domains. Replaces the v1 citation-tracker; storage and domain
aggregates moved to the orchestrator's `tracking` module.

## Endpoints

<!-- GENERATED:endpoints START (source: packages/contracts/openapi/services/citation-extractor.yaml) -->
- `POST /v1/citation-extractions`: `extractCitations`
- `GET /healthz`, `GET /readyz`: shared probes
<!-- GENERATED:endpoints END -->

## Caching (by callers)

<!-- GENERATED:cache START (source: packages/contracts/cache/policy.yaml) -->
Caller cache policy: [policy.yaml](../../packages/contracts/cache/policy.yaml) ([ADR 0016](../adr/0016-cache-first.md)).

keyVersion `1`. The values below are defaults; scope and freshness can be overridden per environment and per customer (policy.yaml `resolution`).

| Operation | Kept for | Scope | Notes |
| --- | --- | --- | --- |
| `extractCitations` | `P30D` | shared |  |
<!-- GENERATED:cache END -->

## Limits

<!-- GENERATED:limits START (source: x-rex-limits in packages/contracts/openapi/services/citation-extractor.yaml) -->
See [the tool's operation limits](../../services/citation-extractor/AGENTS.md#limits).
<!-- GENERATED:limits END -->

## Shared schemas

<!-- GENERATED:shared START (source: packages/contracts/openapi/services/citation-extractor.yaml + common.yaml) -->
- [`Healthz`](../../packages/contracts/openapi/common.yaml) (pathItems); also used by answer-analysis, content-auditor, content-extractor, engine-query, gateway, llms-txt-generator, orchestrator, schema-generator, sitemap-extractor.
- [`Readyz`](../../packages/contracts/openapi/common.yaml) (pathItems); also used by answer-analysis, content-auditor, content-extractor, engine-query, gateway, llms-txt-generator, orchestrator, schema-generator, sitemap-extractor.
- [`BadRequest`](../../packages/contracts/openapi/common.yaml) (responses); also used by answer-analysis, content-auditor, content-extractor, engine-query, llms-txt-generator, orchestrator, schema-generator, sitemap-extractor.
- [`InternalError`](../../packages/contracts/openapi/common.yaml) (responses); also used by answer-analysis, content-auditor, content-extractor, engine-query, llms-txt-generator, orchestrator, schema-generator, sitemap-extractor.
- [`AnswerSource`](../../packages/contracts/openapi/common.yaml) (schemas); also used by engine-query.
- [`Domain`](../../packages/contracts/openapi/common.yaml) (schemas); also used by orchestrator.
- [`TrackedBrand`](../../packages/contracts/openapi/common.yaml) (schemas); also used by answer-analysis.
- [`Url`](../../packages/contracts/openapi/common.yaml) (schemas); also used by content-auditor, content-extractor, llms-txt-generator, orchestrator, schema-generator, sitemap-extractor.
<!-- GENERATED:shared END -->

## Used by

- Worker flow `answer-capture` (third step).

## Dependencies

- None (pure function, no network).
<!-- GENERATED:deps START (source: docs/conventions.md#approved-tool-dependencies) -->
- `fastify`: HTTP server
- `@fastify/sensible`: HTTP errors and helpers
- `@fastify/under-pressure`: load shedding, readiness
- `fastify-openapi-glue`: routes bound to the contract's operationIds (confirmed or replaced by the Phase 1 spike, ADR 0020)
- `ajv`: JSON Schema 2020-12 validation
- `ajv-formats`: formats for Ajv
- `env-schema`: config from env
- `pino`: logs (Fastify's logger)
- `@opentelemetry/sdk-node`: traces and metrics
- `@opentelemetry/auto-instrumentations-node`: HTTP instrumentation (including Node's built-in fetch used by the LLM SDKs)
- `marked`: Markdown lexer for inline links in answer text
<!-- GENERATED:deps END -->
