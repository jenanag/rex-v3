# 0009: Stateless tool services

- **Status:** Accepted (2026-11-22, accepted by Jay)
- **Date:** 2026-11-22
- **Deciders:** Jay Pascual
- **Amended:** 2026-11-22: caching happens outside the tools ([ADR 0016](0016-cache-first.md)); deterministic-first methods ([ADR 0017](0017-deterministic-first-analysis.md)) (allowed while Proposed; see [README](README.md))
- **Amended:** 2026-11-22: tool portability ([ADR 0018](0018-tool-portability.md)) and internal packages ([ADR 0019](0019-internal-packages.md))
- **Amended:** 2026-11-22, at Jay's request: content extraction ([ADR 0021](0021-content-extraction.md))

## Context

The first design gave every microservice its own database schema, queue workers and
events. Each service then needed migrations, an outbox, an inbox and tenancy code, and
services called each other. That is a lot of distributed state for what are mostly
functions: query an engine, analyze a text, audit a page.

## Decision

Every capability that does not need to remember anything is a **tool service**:

- Request in, response out. No database, no migrations, no cache that affects results,
  no queues, no bus, no events, no calls to other REx services.
- APIs are `POST /v1/<noun>` functions (plus static `GET` lists): no resource IDs, no
  201/202, no pagination, no idempotency keys. Slow operations document their maximum
  duration; callers set that timeout.
- Tenant-agnostic: no org or project IDs. Tracked brands are passed as opaque keys
  (`TrackedBrand`), and results refer to those keys.
- Every response that used an LLM returns `usage` (`LlmUsageList`) so the caller can meter
  cost.
- No auth inside tools: access is enforced in front of them ([ADR 0014](0014-auth.md)).
- Self-contained: each tool folder builds, tests and runs on its own with public
  packages and a vendored contract ([ADR 0018](0018-tool-portability.md)).
- No caching inside tools: callers check the cache first ([ADR 0016](0016-cache-first.md)),
  so tools must be deterministic in their inputs where possible and declare everything
  that changes the output (model, analyzers, options) as input.
- LLM operations offer a deterministic method where feasible
  ([ADR 0017](0017-deterministic-first-analysis.md)).
- Operations that are cheap, synchronous and LLM-free may be marked `x-rex-public: true`
  and exposed anonymously through the gateway ([ADR 0013](0013-edge-gateway.md)).
- No page fetching for content and no main-content extraction inside tools: page
  content arrives in the request, extracted by the external content-extractor that
  only workers call ([ADR 0021](0021-content-extraction.md)).

Services renamed or reshaped: `prompt-tracker` becomes **engine-query** (one query to one
engine), `citation-tracker` becomes **citation-extractor**, `ai-traffic-analytics`
becomes **ai-traffic-analyzer**; `notifier` and `report-renderer` are new tools for
Phase 6. `accounts`, `scheduler`, `billing`, `alerts` and `reports` become orchestrator
modules ([ADR 0010](0010-orchestrator.md)).

## Consequences

- Tools are trivial to test, scale and replace; each runs alone with nothing else up.
- They can be built first, in parallel ([roadmap](../roadmap.md)).
- Raw provider responses are not stored by default (tools persist nothing; the
  orchestrator stores what the tool returns).
- Callers must send full inputs (for example brands with aliases on every analysis).

## Alternatives considered

- **Database per service** (v1 design, [ADR 0003](0003-postgres-schema-per-service.md)):
  more autonomy than REx needs, at the cost of distributed transactions and duplicated
  read models.
- **Tools calling each other**: hidden coupling and fan-out; chaining moves to workers
  ([ADR 0015](0015-stateless-workers.md)).
