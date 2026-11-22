# content-extractor

- **Kind:** external ([what that means](../architecture.md#service-map))
- **Phase:** 5
- **Contract:** defined by REx, implemented outside this repo: source [packages/contracts/openapi/services/content-extractor.yaml](../../packages/contracts/openapi/services/content-extractor.yaml); self-contained hand-off copy for its owner [packages/contracts/handoff/content-extractor.openapi.yaml](../../packages/contracts/handoff/content-extractor.openapi.yaml); vendored into workers from Phase 4 ([ADR 0021](../adr/0021-content-extraction.md), [ADR 0023](../adr/0023-llms-txt-pipeline.md))
- **State:** none required by REx (stateless per its contract); workers cache its results
- **Bus:** none

## Purpose

Turns a **URL or HTML** into the page's main content as **normalized text and
Markdown**, plus everything REx needs from the page: the raw response (final URL,
status, relevant headers, HTML), page metadata and, on request, the site's robots.txt
and llms.txt. Finding a site's page URLs is the
[sitemap-extractor](sitemap-extractor.md)'s job (contract 2.0.0 removed `links` and
`sitemap`, [ADR 0023](../adr/0023-llms-txt-pipeline.md)). No REx service reads
websites; external services such as this one do
([ADR 0021](../adr/0021-content-extraction.md)).

On request (`respectRobotsTxt`) it applies the site's robots.txt: REx sets it on
llms.txt page jobs, so a disallowed page is not fetched.

**Implemented externally, in Go, outside this repo.** REx owns the contract; the
service's owner builds to it and to the hand-off copy named above. Any change starts as
a contract change here, then the owner implements it.

## Endpoints

<!-- GENERATED:endpoints START (source: packages/contracts/openapi/services/content-extractor.yaml) -->
- `POST /v1/content-extractions`: `extractContent`
- `GET /healthz`, `GET /readyz`: shared probes
<!-- GENERATED:endpoints END -->

## Caching (by callers)

<!-- GENERATED:cache START (source: packages/contracts/cache/policy.yaml) -->
Callers: workers only. Cache policy: [policy.yaml](../../packages/contracts/cache/policy.yaml) (`external`).

keyVersion `1`. The values below are defaults; scope and freshness can be overridden per environment and per customer (policy.yaml `resolution`).

| Operation | Kept for | Scope | Notes |
| --- | --- | --- | --- |
| `extractContent` | `PT1H` | shared | read back by reference |
<!-- GENERATED:cache END -->

## Limits

<!-- GENERATED:limits START (source: x-rex-limits in packages/contracts/openapi/services/content-extractor.yaml) -->
- `extractContent` (workers only): maxDuration `PT30S`, llm `none`, outboundFetch `several`, fetchTimeout `PT10S`, fetchMaxBytes `2000000`. DEFAULT values; per fetch: the page, plus robots.txt and llms.txt when `include` asks or robots.txt is needed for `respectRobotsTxt`
<!-- GENERATED:limits END -->

## Shared schemas

<!-- GENERATED:shared START (source: packages/contracts/openapi/services/content-extractor.yaml + common.yaml) -->
- [`Healthz`](../../packages/contracts/openapi/common.yaml) (pathItems); also used by answer-analysis, citation-extractor, content-auditor, engine-query, gateway, llms-txt-generator, orchestrator, schema-generator, sitemap-extractor.
- [`Readyz`](../../packages/contracts/openapi/common.yaml) (pathItems); also used by answer-analysis, citation-extractor, content-auditor, engine-query, gateway, llms-txt-generator, orchestrator, schema-generator, sitemap-extractor.
- [`BadRequest`](../../packages/contracts/openapi/common.yaml) (responses); also used by answer-analysis, citation-extractor, content-auditor, engine-query, llms-txt-generator, orchestrator, schema-generator, sitemap-extractor.
- [`InternalError`](../../packages/contracts/openapi/common.yaml) (responses); also used by answer-analysis, citation-extractor, content-auditor, engine-query, llms-txt-generator, orchestrator, schema-generator, sitemap-extractor.
- [`ServiceUnavailable`](../../packages/contracts/openapi/common.yaml) (responses); also used by answer-analysis, content-auditor, engine-query, llms-txt-generator, sitemap-extractor.
- [`UnprocessableContent`](../../packages/contracts/openapi/common.yaml) (responses); also used by answer-analysis, content-auditor, engine-query, llms-txt-generator, orchestrator, schema-generator, sitemap-extractor.
- [`ExtractedContent`](../../packages/contracts/openapi/common.yaml) (schemas); also used by content-auditor, llms-txt-generator.
- [`FetchedFile`](../../packages/contracts/openapi/common.yaml) (schemas); also used by content-auditor, llms-txt-generator, sitemap-extractor.
- [`FetchedPage`](../../packages/contracts/openapi/common.yaml) (schemas); also used by content-auditor.
- [`PageMetadata`](../../packages/contracts/openapi/common.yaml) (schemas); also used by llms-txt-generator.
- [`Url`](../../packages/contracts/openapi/common.yaml) (schemas); also used by citation-extractor, content-auditor, llms-txt-generator, orchestrator, schema-generator, sitemap-extractor.
<!-- GENERATED:shared END -->

## Who calls it

- **Workers only**: the `content-extraction` flow (audits) and the `page-audit` flow
  (llms.txt pipeline), one call per job, cache first
  ([workers](workers.md), [events](../events.md#catalog)). Every fresh result is
  archived to the [data-aggregator](data-aggregator.md) before it is cached
  ([ADR 0022](../adr/0022-page-archive.md)).
- Never the orchestrator, the gateway or any tool. Tools receive its output
  (`ExtractedContent`, `FetchedPage`, `FetchedFile`, `PageMetadata`) in their requests;
  between jobs it travels [by reference](../architecture.md#page-results-by-reference)
  (cache key), never on the bus.

## Building to the contract

- Hand-off: copy `packages/contracts/handoff/content-extractor.openapi.yaml` (one
  self-contained file, regenerated and drift-checked with the other vendored copies)
  into the extractor's repo; generate server types from it (for example with
  `oapi-codegen`) and test responses against it.
- Errors are RFC 9457 problem details (`application/problem+json`, `type`
  `{PROBLEM_BASE_URI}/{code}`, snake_case `code`, `traceId`), as in
  [conventions §4](../conventions.md#4-errors); the 422 codes are listed in the spec.
- Numbers marked DEFAULT (timeouts, size caps, redirect counts)
  are placeholders the owner may tune without a contract change.
- Workers treat 503 and timeouts as retryable and 400/422 as final (bus retry policy).

## Configuration

- Callers: `CONTENT_EXTRACTOR_URL` in workers only ([conventions §12](../conventions.md#12-environment-variables)).
- Runs on the private network inside the cluster, with no authentication: reachable
  only from workers (network policy, [ADR 0014](../adr/0014-auth.md)).
