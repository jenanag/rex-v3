# 0022: Pages are archived to the external data-aggregator at capture time, before they are cached

- **Status:** Accepted (2026-11-22, accepted by Jay)
- **Date:** 2026-11-22
- **Deciders:** Jay Pascual
- **Amends:** [0016](0016-cache-first.md), [0021](0021-content-extraction.md) (by a dated amendment)
- **Amended:** 2026-11-22, at Jay's request: the data-aggregator is also the fallback read path for page results passed by reference (audits and the llms.txt pipeline), and page entries are archived too ([ADR 0023](0023-llms-txt-pipeline.md))

## Context

Jay decided that extracted pages stay in the cache as long as configuration says
(`extractContent` TTL in [policy.yaml](../../packages/contracts/cache/policy.yaml)),
and that before a page leaves the cache it is kept in a separate, external **data
aggregator** for history and analysis. The data-aggregator is owned outside this repo;
its interface, location and auth are not known yet
([data-aggregator](../services/data-aggregator.md)).

A page leaves the cache in two ways: its TTL expires, or `redis-cache` evicts it under
memory pressure (`allkeys-lru`). Redis cannot hand REx a page at that moment: keyspace
notifications are fire-and-forget pub/sub (lost when no subscriber is connected), the
`evicted` and `expired` events carry only the key, and the value is already gone when
they fire. So "archive on removal" cannot be built on Redis.

## Decision

- **Archive at capture time, before the cache write.** A page enters the cache only in
  a worker's call to the content-extractor (a miss or `refresh` on `content-extractor.extractContent`,
  [ADR 0021](0021-content-extraction.md)). In that step the worker sends every fresh
  extractor result (also in `bypass` mode) to the data-aggregator first, then stores it.
  Pages the worker reads from the cache were archived when they were captured.
- **Nothing is cached unarchived.** If the data-aggregator does not accept the page
  (error, timeout, unreachable), the step still succeeds and uses the result, but the
  result is not stored (cache outcome `uncacheable`) and the failure is logged and
  counted. The next request for that page captures and archives it again. Declared in
  policy.yaml as `archiveTo: data-aggregator` on `extractContent` plus a store rule, so
  "removed from the cache" can only ever happen to an archived page. Exception
  (2026-11-22, [ADR 0023](0023-llms-txt-pipeline.md)): a result a later job reads by
  reference (`byReference` in policy.yaml) is not used when the archive refused it;
  the step fails retryably instead.
- **Only workers write to the data-aggregator** (`DATA_AGGREGATOR_URL`, workers only),
  like the content-extractor. The orchestrator, the gateway and tools never call it.
- **What is archived:** every operation with `archiveTo` in policy.yaml: the
  content-extractor's `extractContent` and llms-txt-generator's `describePage` (the
  page's llms.txt entry), each under its cache key.
- **Read back (decided by Jay, [ADR 0023](0023-llms-txt-pipeline.md)):** the
  workers that get page results [by reference](../architecture.md#page-results-by-reference)
  (`content-audit`, `llms-txt-generation`) read them from the cache first and from the
  data-aggregator only on a miss, by the same key. Nothing else reads it.
- Its request shape, auth, idempotency, timeouts and what exactly it stores beyond the
  extraction are open ([deferred decisions](../roadmap.md#deferred-decisions)); the
  worker step is the only code that depends on them.

## Consequences

- No eviction hook, no extra queue, no new message: the archive is one more call in an
  existing step, with no race against Redis eviction.
- Every page in the cache has a copy in the data-aggregator. `bypass` captures, which
  are never cached, are archived too; a capture whose archive failed is neither
  archived nor cached.
- An aggregator outage does not stop audits or llms.txt crawls, but pages are not
  cached while it lasts: more extractor calls, and llms.txt generation re-extracts
  pages instead of reading them back from the cache.
- Extraction latency grows by one archive call per fresh page.
- The archive holds captures, not cache lifetimes: one entry per capture, so a page
  refreshed hourly is archived hourly (the history Jay wants for analysis).

## Alternatives considered

- **Redis keyspace notifications on expiry or eviction:** the value is gone and the
  events are lossy; rejected.
- **Worker publishes a "page captured" event that an archive worker consumes:** a new
  worker-to-worker message pattern, and the full page (up to several MB) crosses the bus
  again, close to the 8 MiB message cap; reconsider if archive latency becomes a
  problem.
- **Orchestrator-issued archive job:** the orchestrator does not hold page content (it
  stays in the cache), so the job would read the cache and race the very eviction it is
  meant to beat; rejected.
- **Periodic scan of the cache:** misses pages evicted between scans; rejected.
