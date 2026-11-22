# schema-generator

- **Kind:** tool ([what that means](../architecture.md#service-map))
- **Phase:** 2
- **Contract:** source [packages/contracts/openapi/services/schema-generator.yaml](../../packages/contracts/openapi/services/schema-generator.yaml); vendored, self-contained copy in [services/schema-generator/contract/](../../services/schema-generator/contract/openapi.yaml) ([ADR 0018](../adr/0018-tool-portability.md))
- **Language:** TypeScript (`language: ts` in vendoring.yaml), as [ADR 0024](../adr/0024-per-tool-language.md) proposes: JSON-LD processing, where jsonld.js is the reference implementation, and HTML parsing; the TypeScript template is hardened here first. Its own language ADR, accepted by Jay, confirms it at the start of its Phase 2 step.
- **Portability:** a self-contained project in its language: copy `services/schema-generator/` anywhere, then its install, build, test and `docker build` work with nothing else present; no auth, no cache, no bus inside ([ADR 0018](../adr/0018-tool-portability.md))
- **State:** none (callers cache its results, see below)
- **Bus:** none

## Purpose

Generates schema.org JSON-LD for a page type from structured input or a page's HTML,
and validates JSON-LD given inline or found in HTML. Both operations are public free
tools and take content only: no network
([ADR 0021](../adr/0021-content-extraction.md)).

## Endpoints

<!-- GENERATED:endpoints START (source: packages/contracts/openapi/services/schema-generator.yaml) -->
- `POST /v1/schema-markup`: `generateSchemaMarkup` (public via gateway at `/v1/tools/schema-markup`)
- `POST /v1/schema-markup/validate`: `validateSchemaMarkup` (public via gateway at `/v1/tools/schema-markup/validate`)
- `GET /healthz`, `GET /readyz`: shared probes
<!-- GENERATED:endpoints END -->

## Caching (by callers)

<!-- GENERATED:cache START (source: packages/contracts/cache/policy.yaml) -->
Caller cache policy: [policy.yaml](../../packages/contracts/cache/policy.yaml) ([ADR 0016](../adr/0016-cache-first.md)).

keyVersion `1`. The values below are defaults; scope and freshness can be overridden per environment and per customer (policy.yaml `resolution`).

| Operation | Kept for | Scope | Notes |
| --- | --- | --- | --- |
| `generateSchemaMarkup` | `P30D` | shared |  |
| `validateSchemaMarkup` | `P30D` | shared |  |
<!-- GENERATED:cache END -->

## Limits

<!-- GENERATED:limits START (source: x-rex-limits in packages/contracts/openapi/services/schema-generator.yaml) -->
See [the tool's operation limits](../../services/schema-generator/AGENTS.md#limits).
<!-- GENERATED:limits END -->

## Shared schemas

<!-- GENERATED:shared START (source: packages/contracts/openapi/services/schema-generator.yaml + common.yaml) -->
- [`Healthz`](../../packages/contracts/openapi/common.yaml) (pathItems); also used by answer-analysis, citation-extractor, content-auditor, content-extractor, engine-query, gateway, llms-txt-generator, orchestrator, sitemap-extractor.
- [`Readyz`](../../packages/contracts/openapi/common.yaml) (pathItems); also used by answer-analysis, citation-extractor, content-auditor, content-extractor, engine-query, gateway, llms-txt-generator, orchestrator, sitemap-extractor.
- [`BadRequest`](../../packages/contracts/openapi/common.yaml) (responses); also used by answer-analysis, citation-extractor, content-auditor, content-extractor, engine-query, llms-txt-generator, orchestrator, sitemap-extractor.
- [`InternalError`](../../packages/contracts/openapi/common.yaml) (responses); also used by answer-analysis, citation-extractor, content-auditor, content-extractor, engine-query, llms-txt-generator, orchestrator, sitemap-extractor.
- [`UnprocessableContent`](../../packages/contracts/openapi/common.yaml) (responses); also used by answer-analysis, content-auditor, content-extractor, engine-query, llms-txt-generator, orchestrator, sitemap-extractor.
- [`Url`](../../packages/contracts/openapi/common.yaml) (schemas); also used by citation-extractor, content-auditor, content-extractor, llms-txt-generator, orchestrator, sitemap-extractor.
- [`ValidationResult`](../../packages/contracts/openapi/common.yaml) (schemas).
<!-- GENERATED:shared END -->

## Used by

- Gateway public routes (HTML or data pasted by the user); later, worker flows that
  propose fixes from a page's stored extraction (Phase 7).

## Dependencies

- None at run time: no network.
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
- `cheerio`: HTML parsing of the raw page passed in
- `jsonld`: JSON-LD expansion for validation
<!-- GENERATED:deps END -->
