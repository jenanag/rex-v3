# content-auditor

- **Kind:** tool ([what that means](../architecture.md#service-map))
- **Phase:** 2
- **Contract:** source [packages/contracts/openapi/services/content-auditor.yaml](../../packages/contracts/openapi/services/content-auditor.yaml); vendored, self-contained copy in [services/content-auditor/contract/](../../services/content-auditor/contract/openapi.yaml) ([ADR 0018](../adr/0018-tool-portability.md))
- **Language:** TypeScript (`language: ts` in vendoring.yaml), per [ADR 0030](../adr/0030-content-auditor-language.md), accepted by Jay on 2026-11-24. Scaffolding is the next step.
- **Portability:** a self-contained project in its language: copy `services/content-auditor/` anywhere, then its install, build, test and `docker build` work with nothing else present; no auth, no cache, no bus inside ([ADR 0018](../adr/0018-tool-portability.md))
- **State:** none (callers cache its results, see below)
- **Bus:** none

## Purpose

Assesses one page for AI readiness (crawler access, structured data, llms.txt, answer
readiness, entity signals, technical basics, freshness) and returns a 0 to 100 score with category scores and
issues. Also checks robots.txt rules for every known
[AI crawler](../../packages/contracts/data/ai-crawlers.yaml). It fetches nothing. The
page's extracted content, raw page and robots.txt are in its request; the
content-extractor service produced them (`content-extraction` job), and the
`content-audit` worker read them back by reference
([ADR 0021](../adr/0021-content-extraction.md),
[page results by reference](../architecture.md#page-results-by-reference)).

## Endpoints

<!-- GENERATED:endpoints START (source: packages/contracts/openapi/services/content-auditor.yaml) -->
- `POST /v1/audits`: `auditPage`
- `POST /v1/crawler-checks`: `checkCrawlerAccess` (public via gateway at `/v1/tools/crawler-checks`)
- `GET /healthz`, `GET /readyz`: shared probes
<!-- GENERATED:endpoints END -->

## Caching (by callers)

<!-- GENERATED:cache START (source: packages/contracts/cache/policy.yaml) -->
Caller cache policy: [policy.yaml](../../packages/contracts/cache/policy.yaml) ([ADR 0016](../adr/0016-cache-first.md)).

keyVersion `1`. The values below are defaults; scope and freshness can be overridden per environment and per customer (policy.yaml `resolution`).

| Operation | Kept for | Scope | Notes |
| --- | --- | --- | --- |
| `auditPage` | `P30D` | shared |  |
| `checkCrawlerAccess` | `P30D` | shared |  |
<!-- GENERATED:cache END -->

## Limits

<!-- GENERATED:limits START (source: x-rex-limits in packages/contracts/openapi/services/content-auditor.yaml) -->
See [the tool's operation limits](../../services/content-auditor/AGENTS.md#limits).
<!-- GENERATED:limits END -->

## Shared schemas

<!-- GENERATED:shared START (source: packages/contracts/openapi/services/content-auditor.yaml + common.yaml) -->
- [`Healthz`](../../packages/contracts/openapi/common.yaml) (pathItems); also used by answer-analysis, citation-extractor, content-extractor, engine-query, gateway, llms-txt-generator, orchestrator, schema-generator, sitemap-extractor.
- [`Readyz`](../../packages/contracts/openapi/common.yaml) (pathItems); also used by answer-analysis, citation-extractor, content-extractor, engine-query, gateway, llms-txt-generator, orchestrator, schema-generator, sitemap-extractor.
- [`BadRequest`](../../packages/contracts/openapi/common.yaml) (responses); also used by answer-analysis, citation-extractor, content-extractor, engine-query, llms-txt-generator, orchestrator, schema-generator, sitemap-extractor.
- [`InternalError`](../../packages/contracts/openapi/common.yaml) (responses); also used by answer-analysis, citation-extractor, content-extractor, engine-query, llms-txt-generator, orchestrator, schema-generator, sitemap-extractor.
- [`ServiceUnavailable`](../../packages/contracts/openapi/common.yaml) (responses); also used by answer-analysis, content-extractor, engine-query, llms-txt-generator, sitemap-extractor.
- [`UnprocessableContent`](../../packages/contracts/openapi/common.yaml) (responses); also used by answer-analysis, content-extractor, engine-query, llms-txt-generator, orchestrator, schema-generator, sitemap-extractor.
- [`AiCrawler`](../../packages/contracts/openapi/common.yaml) (schemas).
- [`ExtractedContent`](../../packages/contracts/openapi/common.yaml) (schemas); also used by content-extractor, llms-txt-generator.
- [`FetchedFile`](../../packages/contracts/openapi/common.yaml) (schemas); also used by content-extractor, llms-txt-generator, sitemap-extractor.
- [`FetchedPage`](../../packages/contracts/openapi/common.yaml) (schemas); also used by content-extractor.
- [`LlmsTxtValidation`](../../packages/contracts/openapi/common.yaml) (schemas); also used by llms-txt-generator.
- [`Timestamp`](../../packages/contracts/openapi/common.yaml) (schemas); also used by orchestrator.
- [`Url`](../../packages/contracts/openapi/common.yaml) (schemas); also used by citation-extractor, content-extractor, llms-txt-generator, orchestrator, schema-generator, sitemap-extractor.
<!-- GENERATED:shared END -->

## Used by

- Worker flow `content-audit` (after the page's `content-extraction` job; the worker
  reads the extraction by reference, then runs llms-txt-generator validation).
- Gateway public route for the crawler check (robots.txt content in the request; by URL,
  use the orchestrator's `createAudit`).

## Dependencies

- None at run time: no network (no fetch, no content-extractor call).
- Vendored data: `contract/ai-crawlers.yaml`.
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
- `cheerio`: HTML parsing of the raw page passed in
- `robots-parser`: robots.txt rules
<!-- GENERATED:deps END -->

## Notes

- The llms.txt category uses the `llmsTxt` validation passed in by the worker; the
  auditor never calls llms-txt-generator.
- Category weights are published here when implemented (Phase 2).
