# 0023: The llms.txt crawl is an event-driven pipeline: sitemap discovery, page audits, LLM-free assembly

- **Status:** Accepted (2026-11-22, accepted by Jay)
- **Date:** 2026-11-22
- **Deciders:** Jay Pascual
- **Amends:** [0021](0021-content-extraction.md) (by a dated amendment), [0022](0022-page-archive.md)
- **Amended:** 2026-11-22, at Jay's request: audits (`createAudit`) use the same page-results-by-reference pattern; whether the sitemap-extractor is a separate service or an endpoint of the content-extractor is the implementer's choice (see [Amendments](#amendments))

## Context

The first llms.txt crawl ([ADR 0021](0021-content-extraction.md) amendments) used
`content-extraction` jobs for discovery and pages, and one `generateLlmsTxt` call that
summarized every page in a single request within 10 minutes. With no page cap that one
call cannot scale, and the per-page work (extraction plus an optional LLM summary) is
redone whenever generation is retried. Jay approved ("go") a redesign into an
event-driven pipeline.

## Decision

**Decided by Jay** (approved flow):

- Everything runs over the `rex.events` topic exchange. The orchestrator owns the
  state and publishes jobs through its outbox; workers consume them and call stateless
  services over REST; services (tools and external services) never touch the bus.
  Messages carry ids, URLs and cache keys, never page bodies.
- **1. Create:** `createLlmsTxt` (site, `respectRobotsTxt`, options) saves the resource
  (`stage: discovering`) and publishes `sitemap-discovery.requested`.
- **2. Discover:** a worker checks the cache, then calls the external
  **sitemap-extractor** (all sitemap URLs, robots.txt honored when enabled), caches the
  URL list and publishes `sitemap-discovery.completed` or `.failed` (failed fails the
  resource). Whether it is a separate service or an endpoint of the Go
  content-extractor is the implementer's choice (see [Amendments](#amendments)); the
  contract is the same either way.
- **3. Audit each page:** the orchestrator saves the selected pages (pending) and
  publishes one `page-audit.requested` per URL. A worker checks the cache (page content,
  then its entry), calls the content-extractor on a miss, archives at capture
  ([ADR 0022](0022-page-archive.md)), caches the page and its entry, and publishes
  `page-audit.completed` or `.failed`. A failed page is skipped and counted. "Audit"
  here means extraction plus the page's llms.txt description (LLM only when the LLM
  summarizer is on), not the content-auditor's checks.
- **4. Assemble:** when every page is terminal and at least one succeeded, the
  orchestrator publishes `llms-txt-generation.requested`. A worker reads the page
  results from the **cache first, then the data-aggregator** on a miss, and calls
  `generateLlmsTxt`, now a fast, LLM-free assembly (llms.txt and optional
  llms-full.txt). The orchestrator stores the result; the client polls the resource,
  which reports `pages {selected, audited, failed}`.
- Retries use the configurable delayed retry queues, then `rex.dead-letters`; services
  never retry; the reconciler times out stuck page audits and the generation.
- `marked` is approved for citation-extractor (engine answers are Markdown, not web
  pages).

**Design details (accepted by Jay, 2026-11-22):**

- **Per-page entry:** a new llms-txt-generator operation, `describePage`
  (`POST /v1/llms-txt/page-entries`), turns one extracted page into its `LlmsTxtEntry`
  (title, description), extractively or with an LLM (`PageEntryOptions`).
  `generateLlmsTxt` takes entries (plus the pages' Markdown for llms-full.txt) and
  declares `llm: none`. The per-page LLM work, its usage and its cache entry move to the
  page step; tools stay network-free.
- **URL discovery lives only in the sitemap-extractor.** The content-extractor's
  `links` and `sitemap` include options and `maxUrls` are removed (contract 2.0.0)
  rather than kept as deprecated: two services implementing the same discovery would
  break DRY, and no implementation or consumer of 1.x exists yet. Link discovery
  survives as the sitemap-extractor's fallback (`via: links`, the site root's
  same-host links) for sites without sitemaps.
- **Cache keys travel in messages.** `ToolCallCache.key` (set by workers) is reported
  in `page-audit.completed`; the orchestrator stores both keys per page and passes
  them in `LlmsTxtGenerationJob.pages` (`PageResultRef`). The same key identifies the
  archived copy in the data-aggregator, so the fallback read needs no other lookup.
- **No bodies on the bus, enforced:** `page-audit.requested` asks for the extraction
  by `url` only (inline `html` is refused by the message schema), and the pipeline
  messages may not reference page or entry schemas (checked).
- **Both page results are archived at capture:** `extractContent` and `describePage`
  carry `archiveTo: data-aggregator` in policy.yaml, so the fallback always has what
  the cache lost. A page found in neither is left out of the file, reported as
  `pagesMissing` and moved from `audited` to `failed`.
- **llms-full.txt bound:** the worker passes page Markdown in listing order only until
  2,000,000 characters (the tool's output cap), so the assembly request stays small
  without a page cap.
- **Robots.txt:** discovery sends the effective `respectRobotsTxt` to the
  sitemap-extractor (disallowed URLs are left out and counted) and every page job
  sends it to the content-extractor (a disallowed page fails as `robots_disallowed`).
- **Progress:** the resource gets `stage` (`discovering`, `auditing`, `generating`,
  `done`); the shared `JobStatus` is unchanged.
- **Reconciler deadlines** (configuration, placeholders): sitemap discovery 30 min,
  page audit 30 min (each page job on its own), llms.txt generation 15 min plus 1 s per page.

## Consequences

- Page work is done once and reused: a retried generation only re-reads the cache
  (or the data-aggregator); a retried page job replays its finished step from the cache.
- Each message stays small: `sitemap-discovery.completed` carries URLs (about 50,000
  fit in the 8 MiB cap), the generation job carries two keys per page (about 20,000
  pages); both limits are noted in the deferred decisions.
- One more contract for Jay to implement, the sitemap-extractor, as a separate service
  or as an endpoint of the content-extractor (his choice), to its hand-off contract.
- The data-aggregator becomes a read path too: workers read archived entries and
  extractions back by cache key (interface still unknown).
- Audits (`createAudit`) use the same pattern since the 2026-11-22 amendment: no page
  body is on the bus anywhere.

## Alternatives considered

- **Keep one summarizing `generateLlmsTxt` call:** bounded by one request and 10
  minutes; rejected by Jay.
- **Keep links and sitemap in the content-extractor and drop the new service:** one
  service doing per-page extraction and site-wide discovery behind one cache entry;
  rejected by Jay in favor of a dedicated discovery step (possibly the same binary).
- **Carry entries in `page-audit.completed`:** small enough, but breaks "ids and cache
  keys, never bodies" and puts LLM output into orchestrator state.

## Amendments

### 2026-11-22: audits by reference, sitemap-extractor deployment (decided by Jay)

- **Audits use the same pattern (decided by Jay):** `createAudit` no longer carries the
  extraction on the bus. A worker checks the cache and, on a miss, calls the
  content-extractor over REST (the service extracts; the worker only makes the call),
  archives the result to the data-aggregator, caches it and publishes
  `content-extraction.completed` with only a page reference (URL and cache key) and the
  cache outcome. The orchestrator publishes `content-audit.requested` with that
  reference; the audit worker reads the extraction from the cache first, then the
  data-aggregator, and calls content-auditor. Both page flows share one schema
  (`PageRef` in events.yaml; the pipeline's `PageResultRef` is a `PageRef` that also
  requires the entry key) and one documented rule,
  [page results by reference](../architecture.md#page-results-by-reference).
- **Sitemap-extractor deployment (decided by Jay: "doesn't matter"):** a separate
  service or an endpoint of the Go content-extractor; the implementer chooses. The
  contract, `SITEMAP_EXTRACTOR_URL` and the cache entry are the same either way.
- **Design details (accepted by Jay, 2026-11-22):** results read by reference are listed under
  `byReference` in policy.yaml and are stored even in `bypass` mode (it acts as
  `refresh` there); a fresh result the data-aggregator refused is not used and the
  producing step fails retryably, so no job reports a reference nobody can read; a
  `content-audit` whose extraction is in neither store fails as `page_result_missing`
  (step `readPageResult`, final); `content-extraction.requested` and
  `page-audit.requested` share `PageExtractionRequest` (by `url` only);
  `page-audit.completed` reports a `PageResultRef` instead of a bare URL; events.yaml
  goes to 3.0.0 (pre-implementation rule, conventions §3).
