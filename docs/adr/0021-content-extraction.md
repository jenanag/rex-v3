# 0021: Content extraction via external content-extractor, called by workers on orchestrator-issued jobs

- **Status:** Accepted (decided by Jay)
- **Date:** 2026-11-22
- **Deciders:** Jay Pascual
- **Amended:** 2026-11-22, at Jay's request: REx defines the extractor's contract; no tool or worker fetches (see [Amendments](#amendments))
- **Amended:** 2026-11-22, at Jay's request: extractor on the private network, crawls obey robots.txt, no page cap, page archive, URL-based structured data via the seo-auditor (see [Amendments](#amendments))
- **Amended:** 2026-11-22, at Jay's request: the llms.txt crawl is an event-driven pipeline ([ADR 0023](0023-llms-txt-pipeline.md)); URL discovery moves to the sitemap-extractor (see [Amendments](#amendments))
- **Amends:** [0009](0009-stateless-tool-services.md), [0013](0013-edge-gateway.md),
  [0015](0015-stateless-workers.md), [0016](0016-cache-first.md)

0020 is reserved for the Phase 1 route-loader spike.

## Context

Several tools need a web page's main content (audits, and later llms.txt and schema
markup). Fetching pages and extracting their main content inside each tool duplicates
hard, network-bound work and puts outbound traffic in every tool. Jay already has an
**external content extractor, built in Go**, that he plugs into REx: it takes a **URL
or HTML** and returns the detected content as **normalized text and Markdown**. Nothing
else about its interface is known yet.

## Decision

Decided by Jay:

- **The external content-extractor does all main-content extraction.** No REx tool
  fetches a page to extract its content or implements main-content extraction.
- **Only workers call it,** on `content-extraction` jobs, through the normal job flow:
  1. The **orchestrator** decides a resource needs a page's content and publishes
     `content-extraction.requested` through its outbox
     ([events.yaml](../../packages/contracts/asyncapi/events.yaml),
     [topology.yaml](../../packages/contracts/bus/topology.yaml)).
  2. A **worker** consumes it, checks the cache first through `@rex/cache`
     (`content-extractor.extractContent` in
     [policy.yaml](../../packages/contracts/cache/policy.yaml) `external`), calls the
     extractor over REST on a miss, and publishes `content-extraction.completed` (or
     `.failed`).
  3. The **orchestrator** stores the result with the resource that asked for it and
     then publishes the tool jobs with the extracted text and Markdown in their
     requests.
- **Never callers:** the orchestrator (it calls no tools and no extractor), the gateway
  and every tool.
- **Public `/v1/tools` operations accept already-extracted content** (or the raw file
  they evaluate, such as robots.txt). A URL-based public flow goes through the
  orchestrator's async, anonymous endpoints (today `createAudit`), which run the jobs
  above.

Applied now (Phase 0 contracts): content-auditor takes `page` (raw HTML and headers),
`content` (`ExtractedContent`) and `robotsTxt` instead of a URL to fetch, and its
public crawler check takes robots.txt content; citation-extractor takes the answer's
Markdown as `markdown` and never opens cited pages. Raw HTML goes only to
content-auditor, because extraction removes what its categories check (JSON-LD, meta
robots, canonical, headers, server-rendered markup). Until the extractor can return
raw page data, the `content-extraction` worker step fetches the page and robots.txt
itself (bounded) when the job's `include` asks for them and sends the HTML to the
extractor: a placeholder listed in the
[deferred decisions](../roadmap.md#deferred-decisions).

Not applied yet: the URL modes of schema-generator (`generateSchemaMarkup`
`source.url`, `validateSchemaMarkup` `url`) and llms-txt-generator (`validateLlmsTxt`
`url`, and `generateLlmsTxt` crawling) keep their contracts until Jay approves the
proposed edits.

## Consequences

- Tools get simpler and network-free (content-auditor, citation-extractor); fewer
  packages (`undici` is no longer needed by content-auditor).
- One more job type and one more round trip through the orchestrator per audit; the
  extracted content is stored once and reused by later tool jobs.
- Extraction results are cached like tool results (shared scope, TTL configurable per
  environment and per customer); redelivered jobs do not call the extractor again.
- The extractor's endpoint, port, auth, error format, limits and field names are open
  until Jay supplies them; only the worker step depends on them.

## Alternatives considered

- **Each tool fetches and extracts:** duplicated extraction logic and outbound traffic
  in every tool; rejected by Jay.
- **The orchestrator calls the extractor:** breaks "the orchestrator calls no external
  work synchronously" (ADR 0015); rejected by Jay in favor of a job.
- **Tools or the gateway call the extractor:** couples tools to another service and
  puts slow network work on the public edge.

## Amendments

### 2026-11-22: REx defines the extractor contract; nothing else fetches (decided by Jay)

- Jay adapts his Go extractor to a contract REx defines:
  [content-extractor.yaml](../../packages/contracts/openapi/services/content-extractor.yaml)
  (`POST /v1/content-extractions`, `extractContent`). Besides text and Markdown it
  returns the raw page (final URL, status, relevant headers, HTML), page metadata and,
  on request, robots.txt, llms.txt, the page's links and sitemap URLs. A
  self-contained copy is generated for him in
  [packages/contracts/handoff/](../../packages/contracts/handoff/content-extractor.openapi.yaml).
  This closes the "interface not known" and "who fetches the raw page" placeholders
  above: workers no longer fetch anything.
- **No tool touches the network** except LLM APIs. schema-generator
  (`generateSchemaMarkup`, `validateSchemaMarkup`) takes HTML instead of URLs;
  llms-txt-generator `validateLlmsTxt` takes a file or inline content and
  `generateLlmsTxt` takes the extracted pages instead of crawling. The public
  URL-mode exceptions, the template's fetch switch and `undici` are gone.
- **llms.txt crawl:** the orchestrator runs discovery (one `content-extraction` job
  with links and sitemap), one `content-extraction` job per selected page, then one
  `llms-txt-generation` job that reads the pages back from the cache and calls the tool
  once ([orchestrator](../services/orchestrator.md#notes)). Every job uses the existing
  job ledger, idempotency keys and reconciler.

### 2026-11-22: private network, robots.txt, no page cap, page archive, seo-auditor (decided by Jay)

- **Where the extractor runs:** on the private network inside the cluster, with no
  auth; only workers can reach it (network policy). Closed.
- **llms.txt crawls obey robots.txt** by default: discovery and page jobs send
  `respectRobotsTxt: true`, and the extractor applies the site's rules (contract
  1.1.0: disallowed URLs are left out of links and sitemap URLs, a disallowed page is
  refused with `robots_disallowed`). Configurable per request (`respectRobotsTxt` on
  `createLlmsTxt`; anonymous requests always obey) and per organization (org setting),
  default true. Audits do not set it (one page a user asked for).
- **No page cap** on llms.txt crawls for now: `maxPages` is optional with no default
  and no maximum. Page limits and queue fairness will be configured per membership
  tier; tiers are deferred ([roadmap](../roadmap.md#deferred-decisions)). The tier
  limit plugs into the same setting resolution (the smaller value wins).
- **Page archive:** pages stay in the cache as configured and are kept in an external
  data-aggregator before they leave it; how: [ADR 0022](0022-page-archive.md).
- **URL-based structured-data check:** done by Jay's existing external **seo-auditor**
  service, repurposed, through the same route as the extractor: an orchestrator job
  that a worker runs by calling the seo-auditor
  ([seo-auditor](../services/seo-auditor.md)). Its interface is not known yet, so no
  job, endpoint or schema is defined until it is. This closes the "URL-based schema
  flow" question; schema-generator keeps taking HTML or data.
- The seo-auditor may fetch the URL itself (unknown), so "only the content-extractor
  reads websites" becomes **only external services read websites**; no REx service (gateway, orchestrator, workers,
  tools) does.

### 2026-11-22: llms.txt pipeline and the sitemap-extractor (decided by Jay)

- Jay approved the event-driven llms.txt pipeline: `sitemap-discovery`, one
  `page-audit` per page, then an LLM-free `llms-txt-generation`
  ([ADR 0023](0023-llms-txt-pipeline.md)). The crawl described in the earlier
  amendments (discovery and page `content-extraction` jobs) is replaced; audits keep
  `content-extraction`, which since ADR 0023's amendment reports a page reference
  instead of the extraction.
- A new external **sitemap-extractor** (a separate service or an endpoint of the Go
  extractor, the implementer's choice)
  lists a site's page URLs, honoring robots.txt when enabled. The content-extractor
  contract drops its `links` and `sitemap` options (2.0.0) and only extracts pages.
- `marked` is approved for citation-extractor.

