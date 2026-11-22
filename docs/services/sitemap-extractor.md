# sitemap-extractor

- **Kind:** external ([what that means](../architecture.md#service-map))
- **Phase:** 5
- **Contract:** defined by REx, implemented outside this repo: source [packages/contracts/openapi/services/sitemap-extractor.yaml](../../packages/contracts/openapi/services/sitemap-extractor.yaml); self-contained hand-off copy for its owner [packages/contracts/handoff/sitemap-extractor.openapi.yaml](../../packages/contracts/handoff/sitemap-extractor.openapi.yaml); vendored into workers from Phase 4 ([ADR 0021](../adr/0021-content-extraction.md), [ADR 0023](../adr/0023-llms-txt-pipeline.md))
- **State:** none required by REx (stateless per its contract); workers cache its results
- **Bus:** none

## Purpose

Lists a site's page URLs for the llms.txt pipeline: every URL in its sitemaps
(robots.txt `Sitemap:` lines, else /sitemap.xml, following sitemap indexes), else the
site root's same-host links, leaving out what robots.txt disallows when asked
(`respectRobotsTxt`). It is the only place in REx that discovers URLs; the
[content-extractor](content-extractor.md) extracts single pages
([ADR 0023](../adr/0023-llms-txt-pipeline.md)).

**Implemented externally, in Go, outside this repo.** Whether it runs as a separate
service or as a second endpoint of the content-extractor is the implementer's choice
(decided by Jay, [ADR 0023](../adr/0023-llms-txt-pipeline.md#amendments)): both work,
with this same contract, its hand-off copy and `SITEMAP_EXTRACTOR_URL`. Any change starts as a contract change here.

## Endpoints

<!-- GENERATED:endpoints START (source: packages/contracts/openapi/services/sitemap-extractor.yaml) -->
- `POST /v1/sitemap-extractions`: `extractSitemapUrls`
- `GET /healthz`, `GET /readyz`: shared probes
<!-- GENERATED:endpoints END -->

## Caching (by callers)

<!-- GENERATED:cache START (source: packages/contracts/cache/policy.yaml) -->
Callers: workers only. Cache policy: [policy.yaml](../../packages/contracts/cache/policy.yaml) (`external`).

keyVersion `1`. The values below are defaults; scope and freshness can be overridden per environment and per customer (policy.yaml `resolution`).

| Operation | Kept for | Scope | Notes |
| --- | --- | --- | --- |
| `extractSitemapUrls` | `PT24H` | shared |  |
<!-- GENERATED:cache END -->

## Limits

<!-- GENERATED:limits START (source: x-rex-limits in packages/contracts/openapi/services/sitemap-extractor.yaml) -->
- `extractSitemapUrls` (workers only): maxDuration `PT2M`, llm `none`, outboundFetch `crawl`, fetchTimeout `PT10S`, fetchMaxBytes `52428800`. DEFAULT values; robots.txt, then sitemap files (at most 1000 files, 52428800 bytes each, the sitemaps.org cap), else the site root
<!-- GENERATED:limits END -->

## Shared schemas

<!-- GENERATED:shared START (source: packages/contracts/openapi/services/sitemap-extractor.yaml + common.yaml) -->
- [`Healthz`](../../packages/contracts/openapi/common.yaml) (pathItems); also used by answer-analysis, citation-extractor, content-auditor, content-extractor, engine-query, gateway, llms-txt-generator, orchestrator, schema-generator.
- [`Readyz`](../../packages/contracts/openapi/common.yaml) (pathItems); also used by answer-analysis, citation-extractor, content-auditor, content-extractor, engine-query, gateway, llms-txt-generator, orchestrator, schema-generator.
- [`BadRequest`](../../packages/contracts/openapi/common.yaml) (responses); also used by answer-analysis, citation-extractor, content-auditor, content-extractor, engine-query, llms-txt-generator, orchestrator, schema-generator.
- [`InternalError`](../../packages/contracts/openapi/common.yaml) (responses); also used by answer-analysis, citation-extractor, content-auditor, content-extractor, engine-query, llms-txt-generator, orchestrator, schema-generator.
- [`ServiceUnavailable`](../../packages/contracts/openapi/common.yaml) (responses); also used by answer-analysis, content-auditor, content-extractor, engine-query, llms-txt-generator.
- [`UnprocessableContent`](../../packages/contracts/openapi/common.yaml) (responses); also used by answer-analysis, content-auditor, content-extractor, engine-query, llms-txt-generator, orchestrator, schema-generator.
- [`FetchedFile`](../../packages/contracts/openapi/common.yaml) (schemas); also used by content-auditor, content-extractor, llms-txt-generator.
- [`Url`](../../packages/contracts/openapi/common.yaml) (schemas); also used by citation-extractor, content-auditor, content-extractor, llms-txt-generator, orchestrator, schema-generator.
<!-- GENERATED:shared END -->

## Who calls it

- **Workers only**: the `sitemap-discovery` flow (one call per llms.txt resource)
  ([workers](workers.md), [events](../events.md#catalog)). Never the orchestrator, the
  gateway or any tool. Its URL list goes to the orchestrator in
  `sitemap-discovery.completed` (without the robots.txt body).

## Building to the contract

- Hand-off: copy `packages/contracts/handoff/sitemap-extractor.openapi.yaml` into the
  implementing repo (or merge its path into the content-extractor's server); generate
  server types from it and test responses against it.
- Fetching rules (SSRF guard, User-Agent, redirects) and robots.txt reading
  (RFC 9309) are the content-extractor's; share the code if it is the same binary.
- Errors are RFC 9457 problem details as in [conventions §4](../conventions.md#4-errors);
  the 422 codes are listed in the spec. Numbers marked DEFAULT are placeholders the
  owner may tune without a contract change.
- Workers treat 503 and timeouts as retryable and 400/422 as final (bus retry policy).

## Configuration

- Callers: `SITEMAP_EXTRACTOR_URL` in workers only ([conventions §12](../conventions.md#12-environment-variables)); it may equal `CONTENT_EXTRACTOR_URL` when both run in one binary.
- Runs on the private network inside the cluster, with no authentication: reachable
  only from workers (network policy, [ADR 0014](../adr/0014-auth.md)).
