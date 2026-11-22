# 0015: Stateless workers chain tools

- **Status:** Accepted (2026-11-22, accepted by Jay)
- **Date:** 2026-11-22
- **Deciders:** Jay Pascual
- **Amended:** 2026-11-22: tool calls are cache first, which makes redelivery cheap ([ADR 0016](0016-cache-first.md)) (allowed while Proposed; see [README](README.md))
- **Amended:** 2026-11-22: tool portability ([ADR 0018](0018-tool-portability.md)) and internal packages ([ADR 0019](0019-internal-packages.md))
- **Amended:** 2026-11-22, at Jay's request: content extraction ([ADR 0021](0021-content-extraction.md))

## Context

Jobs often need several tools in sequence (answer capture: engine-query, then
answer-analysis, then citation-extractor). Something must chain them, retry them and
report results, without tools calling each other and without a second database writer.

## Decision

- One **workers** service consumes `<job>.requested` from its queues, runs the job's
  **flow** (`src/flows/<job>.ts`) by calling tools over REST through clients generated
  from its vendored tool specs, with per-operation timeouts (no tokens: tools trust the
  network policy, [ADR 0014](0014-auth.md)), and publishes exactly one
  `<job>.completed` (tool responses verbatim) or `<job>.failed` (`JobFailure`).
- Workers never write or read the database and keep no state between messages;
  everything a job needs is in its message. Their only shared store is the tool-result
  cache: **every tool call is cache first** through `@rex/cache`
  ([ADR 0016](0016-cache-first.md)), honoring the job's `CacheDirective`, and each
  call's outcome is reported in the result.
- Errors are classified: retryable (429, 503, timeouts, network) go to the next delay
  of the queue's configurable retry policy ([ADR 0011](0011-rabbitmq-bus.md)); final (400, 422, last tier) produce `.failed`. The job is acked only after the
  result or retry publish is confirmed.
- Deployments are grouped by queue with `WORKER_QUEUES` and autoscaled on queue depth.
- Workers are the only callers of the external content-extractor, on
  `content-extraction` jobs, cache first like a tool call
  ([ADR 0021](0021-content-extraction.md)).
- A retried or redelivered job reruns its flow, but steps that already succeeded are
  served from the cache, so only the failed step calls its tool again.

## Consequences

- Workers scale to zero and recover from any crash by redelivery.
- Redelivery rarely repeats LLM calls: completed steps hit the cache and single-flight
  locks cover a job racing its own redelivery. Results are still deduped by the
  orchestrator.
- If the cache is down, workers call tools directly (degraded cost, same correctness).

## Alternatives considered

- **Orchestrator calls tools directly**: couples API latency and DB connections to slow
  LLM calls; loses prefetch-based concurrency caps.
- **Workflow engine (Temporal)**: durable step state and retries per step, but another
  stateful system; revisit if flows grow long.
- **Workers write results to the DB**: a second writer, against [ADR 0010](0010-orchestrator.md).
