# workers

- **Kind:** workers ([what that means](../architecture.md#service-map))
- **Phase:** 4
- **Contract:** [asyncapi/events.yaml](../../packages/contracts/asyncapi/events.yaml) and [bus/topology.yaml](../../packages/contracts/bus/topology.yaml) (no HTTP API besides probes)
- **State:** none of its own; shared tool-result cache `redis-cache`
- **Bus:** consumes jobs, publishes results

## Purpose

Stateless job runners ([ADR 0015](../adr/0015-stateless-workers.md)). Each consumes jobs,
chains tool calls over REST and publishes one result. Workers are also the only callers
of the external services: the [content-extractor](content-extractor.md)
([ADR 0021](../adr/0021-content-extraction.md)), the
[sitemap-extractor](sitemap-extractor.md) ([ADR 0023](../adr/0023-llms-txt-pipeline.md)), the
[data-aggregator](data-aggregator.md) ([ADR 0022](../adr/0022-page-archive.md)) and,
once its interface is known, the [seo-auditor](seo-auditor.md). No database and no state between
messages. **Every tool call is cache first** through `@rex/cache`
([ADR 0016](../adr/0016-cache-first.md)): look up `redis-cache`, call the tool only on a
miss, store cacheable results, and report one `ToolCallCache` per call in the result.

## Flows

| Job | Tool calls, in order | Result `data` |
|---|---|---|
| `answer-capture` | engine-query `queryEngine` (cache variant = sample index); answer-analysis `analyzeAnswer` (answer text + `analysis` options: brands, sentiment analyzers); citation-extractor `extractCitations` (answer Markdown as `markdown`, sources, brands) | `{capture, analysis, citations, cache}` |
| `content-extraction` | content-extractor `extractContent` with the job's request, cache first (the service fetches and extracts; the worker only calls it); a fresh result is archived to the data-aggregator before it is cached (`archiveTo`) | `{page, cache}` (a `PageRef`, never the extraction) |
| `content-audit` | read the extraction [by reference](../architecture.md#page-results-by-reference) (`page.extractionKey`); llms-txt-generator `validateLlmsTxt` with its `llmsTxt` (skipped when absent); content-auditor `auditPage` with its `page`, `content` and `robotsTxt`, that validation and the job's `options` | `{result, cache}` |
| `sitemap-discovery` | sitemap-extractor `extractSitemapUrls` with the job's request, cache first | `{discovery, cache}` (URLs, never the robots.txt body) |
| `page-audit` | content-extractor `extractContent` with `request.extraction`, cache first (the service extracts; a fresh result is archived to the data-aggregator before it is cached); llms-txt-generator `describePage` with the page's `url`, `metadata`, `content` and `request.entry`, cache first (archived the same way) | `{page, cache, usage}` (a `PageResultRef`, never the page or entry) |
| `llms-txt-generation` | for each page ref in the job, read [by reference](../architecture.md#page-results-by-reference) its `describePage` result (`entryKey`) and, with `includeFull`, its extraction (`extractionKey`; Markdown only until 2,000,000 characters in total); a page found in neither store is left out and counted; then llms-txt-generator `generateLlmsTxt` (no LLM call) | `{generation, pagesMissing, cache}` |

Planned flows: [events.md#planned-messages-no-schema-yet](../events.md#planned-messages-no-schema-yet).

## Messages

<!-- GENERATED:messages START (source: asyncapi/events.yaml + bus/topology.yaml) -->
- **Publishes:** [`answer-capture.completed`](../events.md#catalog), [`answer-capture.failed`](../events.md#catalog), [`content-extraction.completed`](../events.md#catalog), [`content-extraction.failed`](../events.md#catalog), [`content-audit.completed`](../events.md#catalog), [`content-audit.failed`](../events.md#catalog), [`sitemap-discovery.completed`](../events.md#catalog), [`sitemap-discovery.failed`](../events.md#catalog), [`page-audit.completed`](../events.md#catalog), [`page-audit.failed`](../events.md#catalog), [`llms-txt-generation.completed`](../events.md#catalog), [`llms-txt-generation.failed`](../events.md#catalog)
- **Consumes:**
  - `rex.workers.answer-capture.{engine}` (prefetch 4): [`answer-capture.requested`](../events.md#catalog)
  - `rex.workers.content-extraction` (prefetch 2): [`content-extraction.requested`](../events.md#catalog)
  - `rex.workers.content-audit` (prefetch 2): [`content-audit.requested`](../events.md#catalog)
  - `rex.workers.sitemap-discovery` (prefetch 2): [`sitemap-discovery.requested`](../events.md#catalog)
  - `rex.workers.page-audit` (prefetch 4): [`page-audit.requested`](../events.md#catalog)
  - `rex.workers.llms-txt-generation` (prefetch 1): [`llms-txt-generation.requested`](../events.md#catalog)
<!-- GENERATED:messages END -->

## Behavior

- Acks a job only after its result (or retry copy) is confirmed by the broker.
- Honors the job's `cache` directive (mode, variant, per-customer overrides) for every
  call; `@rex/cache` resolves the effective settings as policy.yaml `resolution`
  defines. A retried or redelivered job serves its finished steps from the cache, so
  only the failed step calls its tool again.
- Retryable errors (tool 429/503, timeouts, network) go to the next delay of the queue's
  configurable retry policy (`retry` in topology.yaml; values deferred); final errors
  (tool 400/422, retries used up) publish `<job>.failed` with the failing `step`.
- Timeouts per tool call come from the operation's documented maximum duration.
- Workers never publish anything but their job's `.completed` or `.failed`, and the
  services they call never touch the bus.
- Workers never fetch or extract anything: the content-extractor and sitemap-extractor
  services do, and a worker only calls them. Page results travel
  [by reference](../architecture.md#page-results-by-reference), never in messages.
- `WORKER_QUEUES` selects the queues a deployment consumes; prefetch comes from
  topology.yaml.

## Dependencies

- RabbitMQ; `redis-cache`; tool services and the external services:
  [content-extractor](content-extractor.md) at `CONTENT_EXTRACTOR_URL`,
  [sitemap-extractor](sitemap-extractor.md) at `SITEMAP_EXTRACTOR_URL`,
  [data-aggregator](data-aggregator.md) at `DATA_AGGREGATOR_URL` and later the
  [seo-auditor](seo-auditor.md) at `SEO_AUDITOR_URL` (tools and both extractors
  are called without a token; the others' auth is not known yet). Workers never fetch
  websites themselves and make no HTTP calls to the orchestrator.
- Packages: `@rex/bus` and `@rex/cache` (pinned, [ADR 0019](../adr/0019-internal-packages.md)); tool clients generated from vendored specs (`openapi-typescript` + `openapi-fetch`).
- Vendored contracts: events, topology, cache policy, specs of the tools and of the
  content-extractor and sitemap-extractor (the other external services' once they
  exist).
