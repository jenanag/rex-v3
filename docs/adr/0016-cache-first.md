# 0016: Cache-first tool calls (self-hosted Redis)

- **Status:** Accepted (2026-11-22, accepted by Jay)
- **Date:** 2026-11-22
- **Deciders:** Jay Pascual
- **Amended:** 2026-11-22: cache scope `shared | tenant` and per-customer overrides of
  scope and TTLs.
- **Amended:** 2026-11-22: tool portability ([ADR 0018](0018-tool-portability.md)) and internal packages ([ADR 0019](0019-internal-packages.md))
- **Amended:** 2026-11-22, at Jay's request: content extraction ([ADR 0021](0021-content-extraction.md))
- **Amended:** 2026-11-22, at Jay's request: pages are archived before they are cached ([ADR 0022](0022-page-archive.md))
- **Amended by:** [0042](0042-cache-window-expiry-and-single-flight-deadlines.md), 2026-11-25 (accepted by Jay), for the single-flight guarantee under **Redelivery**.

## Context

Tool calls are often repeated with the same input: the same prompt on the same engine in
several projects or several times a day, a redelivered job that redoes the calls that
already succeeded, the same URL checked by many anonymous visitors. LLM calls are the
main variable cost. Jay's requirement: a cache must exist and be checked before any
tool service is hit. Tools must stay stateless.

## Decision

- **Every tool call is cache first.** The cache lives outside the tools, in the two
  places that call them: **workers** (every call of every flow) and the **gateway**
  (public tool operations). Both use one wrapper, `@rex/cache` (`packages/cache`,
  published and pinned, [ADR 0019](0019-internal-packages.md)); nothing else
  derives keys or talks to the cache, and tools never reference it. Workers' calls to
  the external content-extractor are cached the same way (`external` in policy.yaml,
  [ADR 0021](0021-content-extraction.md)).
- **One policy file**, [`cache/policy.yaml`](../../packages/contracts/cache/policy.yaml),
  defines the key derivation (what goes into a key, including the tool version and the
  model or engine parameters, and how the input is canonicalized and hashed), the modes,
  the store rules, the scope and a TTL or window per operation, and how those settings
  are resolved.
- **Scope:** `shared` (every customer with the same input gets the same entry) is the
  default for every operation; `tenant` keeps entries per organization, with the org
  id in the key only then. Switching an operation, or one customer, to `tenant` is a
  configuration change, not a code change.
- **Configurable per environment and per customer:** TTLs, windows and scope keep the
  policy.yaml values as defaults; each can be overridden per environment and per
  customer.
  Per-customer overrides are org settings in the orchestrator, sent to workers inside
  each job's `CacheDirective`, so workers and the gateway stay database-free. The
  precedence of the layers and what each layer may change are defined only in
  policy.yaml (`resolution`). The admin API to edit per-customer overrides comes with
  roles ([deferred decisions](../roadmap.md#deferred-decisions)).
- **Modes:** `use` (default), `refresh` (call and overwrite) and `bypass`. Jobs carry
  them in `CacheDirective`; orchestrator endpoints expose `cacheMode`; public calls map
  `Cache-Control: no-cache` to `refresh` (counted double against the rate limit).
- **What is cached:** successful (2xx) responses only. Not cached: errors, timeouts,
  partial results (for example a failed LLM analyzer), values above the size limit,
  operations with side effects (`cacheable: false`, Phase 6 notifier and uploads), and
  extracted pages the data-aggregator did not accept (`archiveTo`,
  [ADR 0022](0022-page-archive.md)).
  engine-query answers are cached per UTC day (window `P1D`) and per sample (`variant`),
  so tracking still gets fresh daily answers and independent samples.
- **Redelivery:** a worker checks the cache before every step, so a redelivered or
  retried job replays the steps that already succeeded from the cache and only repeats
  the failed one. Single-flight locks stop concurrent identical misses from calling a
  tool twice.
- **Transparency and billing:** results report a `ToolCallCache` entry per call
  (`outcome`, `cachedAt`); the gateway sets `X-Rex-Cache` and `X-Rex-Cached-At`.
  The orchestrator meters LLM usage only for calls that were not cache hits.
- **Backend: self-hosted Redis 7.x** (Valkey compatible), a dedicated `redis-cache`
  instance with `maxmemory-policy allkeys-lru` and no AOF; the gateway's rate limits and
  token cache use a separate `redis-edge` instance with `noeviction`, because eviction
  policy is per instance and rate-limit counters must never be evicted.

## Why Redis, self-hosted

- Shared by all worker and gateway replicas (an in-process cache would miss across
  replicas and redeliveries), sub-millisecond reads, native TTLs, `SET NX PX` for
  single-flight, LRU eviction under memory pressure, values up to the 8 MiB message cap.
- Already needed by the gateway, so no new technology; self-hosting matches the
  RabbitMQ decision ([ADR 0011](0011-rabbitmq-bus.md)): same Kubernetes operations, no
  vendor cost, and the same image in dev (`docker compose`) and prod.
- Losing the cache is safe (it is never a source of truth), so a single primary with a
  replica, no persistence, is enough; an outage degrades to direct tool calls.

## Consequences

- Repeated LLM work and redelivery cost drop to near zero; public free tools absorb
  traffic spikes.
- Results may be up to one TTL or window old; callers that need fresh data use
  `refresh`. Sharing across customers is the default (`scope: shared`), since tool
  outputs depend only on their input; an operation or a customer can be switched to
  `tenant`, at the cost of a lower hit ratio for that traffic.
- Customers with different TTLs can share an entry because freshness is checked
  against each caller's own TTL when reading.
- A tool change that alters outputs must bump its `keyVersion` (review checklist item).
- One more stateful component to run and monitor (memory, hit ratio, evictions).

## Alternatives considered

- **Cache inside each tool**: breaks statelessness and duplicates the logic per tool.
- **HTTP caching proxy in front of tools (Varnish, nginx)**: POST bodies, per-operation
  windows, variants and single-flight are awkward; billing metadata would be lost.
- **Postgres as cache**: workers and the gateway would need database access.
- **Managed Redis**: less ops, recurring cost; same trade-off as RabbitMQ.
- **Memcached**: `add` could serve as a lock, but the 1 MiB default item limit, no
  built-in replication and a second technology next to the gateway's Redis rule it out.
