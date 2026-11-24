# content-auditor

- **Kind:** tool ([what that means](../architecture.md#service-map))
- **Phase:** 2
- **Contract:** source [packages/contracts/openapi/services/content-auditor.yaml](../../packages/contracts/openapi/services/content-auditor.yaml); vendored, self-contained copy in [services/content-auditor/contract/](../../services/content-auditor/contract/openapi.yaml) ([ADR 0018](../adr/0018-tool-portability.md))
- **Language:** TypeScript (`language: ts` in vendoring.yaml), per [ADR 0030](../adr/0030-content-auditor-language.md), accepted by Jay on 2026-11-24. Both operations are implemented.
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

keyVersion `3`. The values below are defaults; scope and freshness can be overridden per environment and per customer (policy.yaml `resolution`).

| Operation | Kept for | Scope | Notes |
| --- | --- | --- | --- |
| `auditPage` | `P30D` | shared |  |
| `checkCrawlerAccess` | `P30D` | shared | raw URL key inputs `siteUrl` from `/siteUrl`, `robotsTxtUrl` from `/robotsTxt/url` |
<!-- GENERATED:cache END -->

## Limits

Jay accepted [ADR 0031](../adr/0031-content-auditor-body-limits.md) on 2026-11-24.
The scaffold sets `BODY_LIMIT_BYTES=25165824` (24 MiB) for `auditPage` and a
3,145,728-byte (3 MiB) Fastify route limit for public `checkCrawlerAccess`.
`auditPage` returns an audit and `checkCrawlerAccess` evaluates supplied robots.txt offline.

### Request validation benchmark

From `services/content-auditor/`, run `npm ci`, `npm run build`, and
`node scripts/benchmark-validation.mjs` with the Node version in the root
`.nvmrc`. The shared tool workflow runs the same benchmark offline. It checks
that exact-limit requests reach their handlers and return HTTP 200, and that
adding one byte returns HTTP 413.
The validator-only p99 gates require less than 120 ms for
audits and less than 15 ms for crawler checks. The public route's end-to-end
target remains p99 under 2 seconds.

### Crawler access smoke and latency check

With the repo-pinned Node version, run `npm ci` and `npm run build` from the tool
folder. Start it with `LOG_LEVEL=silent npm start`. In a second terminal run
`node scripts/smoke-crawler-access.mjs`. For a different port, set `PORT` for both
commands. The script sends synthetic requests over loopback, checks the results,
and reports per-workload end-to-end p99 and counts of requests with
budget-limited results. This measures the standalone tool on the request path.
The public gateway should repeat the measurement when available.

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

## Audit scoring

- The llms.txt category uses the `llmsTxt` validation passed in by the worker; the
  auditor never calls llms-txt-generator.
- Each selected category carries equal weight, and its applicable checks
  carry equal weight. Pass earns 1, warn earns 0.5, and fail earns 0.
  A category score is 100 times its mean check points. The overall score is
  the mean of the unrounded applicable category scores. Round each published
  score to the nearest integer, with halves rounding up.
- The response lists all checks for selected categories. Exclude
  `not_applicable` checks from the scoring denominator and omit the score
  for a category with no applicable checks. Unselected categories appear
  in neither array. Categories follow contract order, with fixed check order
  and vendored crawler order within categories.
- When all selected checks are `not_applicable`, return HTTP 200 with
  `score: 0`, an empty categoryScores array, and the `not_applicable` findings.
  If all applicable checks fail, the response includes their zero category scores.
- JSON-LD checks cover local syntax and shape. Custom, aliased, and remote
  contexts are outside the offline check. Freshness reports date evidence and
  chronology from the request, independent of the current time.

## Crawler access results

The check uses the site origin's root and the supplied robots.txt. Results are in
vendored crawler order. A blocked root is `disallowed`. An allowed root with a
confirmed blocked path or query is `partial`. Effective allow overrides count
before classifying a path. A bounded search returns `unknown` if it cannot resolve
the rules within 50,000 work units per selected group and 250,000 per request.
The response preserves the selected group when known. A bare named header falls
back to a registered wildcard; a named `Crawl-delay` directive can shadow it.

Same-origin fetch results give HTTP 200. All 4xx allow crawling; unavailable or
indeterminate fetch evidence yields `unknown`. Unparseable URLs and origin
mismatches yield HTTP 422. The response echoes the supplied URLs and status.
Callers own receipt time. See the [source contract](../../packages/contracts/openapi/services/content-auditor.yaml)
for the status and access definitions.
