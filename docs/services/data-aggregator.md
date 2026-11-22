# data-aggregator

- **Kind:** external ([what that means](../architecture.md#service-map))
- **Phase:** 5
- **Contract:** not known yet: owned and implemented outside this repo; REx adds `packages/contracts/openapi/services/data-aggregator.yaml` once the interface is decided with its owner ([deferred decisions](../roadmap.md#deferred-decisions)) and vendors it into workers like the content-extractor's
- **State:** its own (the page archive, owned outside REx); REx reads from it only as the fallback for page results passed by reference
- **Bus:** none

## Purpose

Keeps every page REx extracts, and each page's llms.txt entry, for history and
analysis. They live in the REx cache only as long as configuration says (TTLs in
[policy.yaml](../../packages/contracts/cache/policy.yaml)); before one can leave the
cache it is already in the data-aggregator, under its cache key. It is an external service, owned and
implemented outside this repo.

## How REx writes to it

Decided in [ADR 0022](../adr/0022-page-archive.md): **at capture time, before the cache
write**, by the worker step that produced the result.

- Every fresh result of an operation with `archiveTo: data-aggregator` in policy.yaml
  (content-extractor `extractContent`, llms-txt-generator `describePage`; cache miss,
  `refresh` or `bypass`) is sent to the data-aggregator first, then stored in the
  cache.
- If it does not accept the page, the step still uses the result but does not cache it
  (outcome `uncacheable`), and logs and counts the failure; the next request captures
  and archives the page again. So no page leaves the cache unarchived. For a result a
  later job reads by reference (`byReference` in policy.yaml: every `extractContent`
  and `describePage`), the step fails retryably instead
  ([ADR 0023](../adr/0023-llms-txt-pipeline.md#amendments)).
- No Redis eviction or expiry hook: Redis cannot hand over a value when it evicts or
  expires it (see the ADR).

## Who calls it

- **Workers only.** They write in the page steps and read only when a job gets page
  results [by reference](../architecture.md#page-results-by-reference)
  (`content-audit`, `llms-txt-generation`), after a cache miss, by cache key (decided
  by Jay, [ADR 0023](../adr/0023-llms-txt-pipeline.md)). Never the orchestrator, the gateway or
  any tool.

## Not known yet

Listed in the [deferred decisions](../roadmap.md#deferred-decisions); none is guessed
here: its endpoints for writing and for reading a result back by cache key, what it
needs besides the result (capture time, organization), whether it accepts the page synchronously or queues it,
idempotency for retried captures, error format, auth and where it runs, time and size
limits, retention, and who may query it for analysis.

## Configuration

- Callers: `DATA_AGGREGATOR_URL` in workers only ([conventions §12](../conventions.md#12-environment-variables)).
