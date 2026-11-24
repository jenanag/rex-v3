# Bus messages

Readable catalog of everything on the RabbitMQ bus. **Sources of truth:**
[`asyncapi/events.yaml`](../packages/contracts/asyncapi/events.yaml) (message names,
versions, producers, payloads) and [`bus/topology.yaml`](../packages/contracts/bus/topology.yaml)
(exchanges, queues, bindings, retry, dead-lettering; consumers are derived from its
bindings). The table between the `GENERATED` markers is generated from both
(`scripts/gen-docs`, Phase 1; CI fails if it drifts). Decisions:
[ADR 0011](adr/0011-rabbitmq-bus.md), [ADR 0012](adr/0012-bus-contracts.md).

## Model

The bus carries **jobs and their results**, nothing else:

- The orchestrator publishes `<job>.requested`; a worker runs the job by calling tool
  services over REST.
- The worker publishes exactly one of `<job>.completed` or `<job>.failed`; the
  orchestrator consumes it and writes the database.
- Tools, the gateway and the dashboard never touch the bus. Changes inside the
  orchestrator (brands edited, org deleted, key revoked) are in-process, not messages.

## Envelope

Every message body is one JSON object: the shared `Envelope` (defined in events.yaml)
with a message-specific `data`. Example result:

```json
{
  "id": "evt_01JD3ZB4S8M6Q2W0E9R7T5Y3V1",
  "type": "answer-capture.completed",
  "version": 1,
  "occurredAt": "2026-11-22T06:00:12.345Z",
  "producer": "workers",
  "orgId": "org_01JD3Z8XQK5V7N2M4P6R8T0W2Y",
  "projectId": "prj_01JD3Z9A1B2C3D4E5F6G7H8J9K",
  "idempotencyKey": "answer:run_01JD3ZA0000000000000000000:prm_01JD3ZA1111111111111111111:chatgpt:0",
  "causationId": "evt_01JD3ZB0000000000000000000",
  "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  "data": {
    "capture": "...", "analysis": "...", "citations": "... (tool responses verbatim)",
    "cache": [
      { "tool": "engine-query", "operationId": "queryEngine", "outcome": "hit", "cachedAt": "2026-11-22T01:15:03.000Z" },
      { "tool": "answer-analysis", "operationId": "analyzeAnswer", "outcome": "miss", "cachedAt": null },
      { "tool": "citation-extractor", "operationId": "extractCitations", "outcome": "miss", "cachedAt": null }
    ]
  }
}
```

**Payload rule.** A `requested` message carries exactly the tool input(s) (`$ref` to the
tool's request schema, or the part of it known before the flow starts, such as
`AnswerAnalysisOptions`) plus an optional `cache` directive; a `completed` message
carries exactly the tool output(s) (`$ref` to the tool's response schema) plus `cache`,
one `ToolCallCache` per tool call ([ADR 0016](adr/0016-cache-first.md)); every `failed`
message carries `JobFailure`. Job
subjects (run, prompt, audit IDs) are not in the payload: the orchestrator maps
`idempotencyKey` to the subject in its job ledger.

## Catalog

<!-- GENERATED:catalog START (source: asyncapi/events.yaml + bus/topology.yaml) -->
| Message | v | Routing key | Producer | Consumer (queue) | `data` | Summary |
| --- | --- | --- | --- | --- | --- | --- |
| `answer-capture.requested` | 1 | `answer-capture.requested.{engine}` | orchestrator | workers (`rex.workers.answer-capture.<engine>`) | { `engine`: EngineId, `query`: [EngineQuery](../packages/contracts/openapi/services/engine-query.yaml), `analysis`: [AnswerAnalysisOptions](../packages/contracts/openapi/services/answer-analysis.yaml), `cache`: CacheDirective } | Capture one answer (prompt x engine x sample) and analyze it. |
| `answer-capture.completed` | 1 | `answer-capture.completed` | workers | orchestrator (`rex.orchestrator.results`) | { `engine`: EngineId, `cache`: ToolCallCacheList, `capture`: [EngineAnswerResult](../packages/contracts/openapi/services/engine-query.yaml), `analysis`: [AnswerAnalysis](../packages/contracts/openapi/services/answer-analysis.yaml), `citations`: [CitationExtraction](../packages/contracts/openapi/services/citation-extractor.yaml) } | The captured answer with its mentions, citations, LLM usage (tool responses verbatim) and cache outcomes. |
| `answer-capture.failed` | 1 | `answer-capture.failed` | workers | orchestrator (`rex.orchestrator.results`) | `JobFailure` | The answer could not be captured or analyzed after all retries. |
| `content-extraction.requested` | 1 | `content-extraction.requested` | orchestrator | workers (`rex.workers.content-extraction`) | { `request`: PageExtractionRequest, `cache`: CacheDirective } | Have the content-extractor extract one page for an audit. |
| `content-extraction.completed` | 1 | `content-extraction.completed` | workers | orchestrator (`rex.orchestrator.results`) | { `page`: PageRef, `cache`: ToolCallCacheList } | Where the extraction is stored (page reference) and the cache outcome; no page body. |
| `content-extraction.failed` | 1 | `content-extraction.failed` | workers | orchestrator (`rex.orchestrator.results`) | `JobFailure` | The content could not be extracted after all retries. |
| `content-audit.requested` | 1 | `content-audit.requested` | orchestrator | workers (`rex.workers.content-audit`) | { `request`: AuditJob, `cache`: CacheDirective } | Audit one page from its stored extraction, by reference. |
| `content-audit.completed` | 1 | `content-audit.completed` | workers | orchestrator (`rex.orchestrator.results`) | { `cache`: ToolCallCacheList, `result`: [AuditResult](../packages/contracts/openapi/services/content-auditor.yaml) } | The audit result and cache outcomes. |
| `content-audit.failed` | 1 | `content-audit.failed` | workers | orchestrator (`rex.orchestrator.results`) | `JobFailure` | The audit failed after all retries. |
| `sitemap-discovery.requested` | 1 | `sitemap-discovery.requested` | orchestrator | workers (`rex.workers.sitemap-discovery`) | { `request`: [SitemapExtractionRequest](../packages/contracts/openapi/services/sitemap-extractor.yaml), `cache`: CacheDirective } | List the page URLs of an llms.txt site. |
| `sitemap-discovery.completed` | 1 | `sitemap-discovery.completed` | workers | orchestrator (`rex.orchestrator.results`) | { `cache`: ToolCallCacheList, `discovery`: SitemapDiscovery } | The discovered URLs and the cache outcome (with its key). |
| `sitemap-discovery.failed` | 1 | `sitemap-discovery.failed` | workers | orchestrator (`rex.orchestrator.results`) | `JobFailure` | The job failed after all retries. |
| `page-audit.requested` | 1 | `page-audit.requested` | orchestrator | workers (`rex.workers.page-audit`) | { `request`: PageAuditJob, `cache`: CacheDirective } | Have one page extracted and its llms.txt entry written. |
| `page-audit.completed` | 1 | `page-audit.completed` | workers | orchestrator (`rex.orchestrator.results`) | { `page`: PageResultRef, `cache`: ToolCallCacheList, `usage`: LlmUsageList } | Where the page's extraction and entry are stored (page reference), the cache outcomes, and LLM usage. |
| `page-audit.failed` | 1 | `page-audit.failed` | workers | orchestrator (`rex.orchestrator.results`) | `JobFailure` | The job failed after all retries. |
| `llms-txt-generation.requested` | 1 | `llms-txt-generation.requested` | orchestrator | workers (`rex.workers.llms-txt-generation`) | { `request`: LlmsTxtGenerationJob, `cache`: CacheDirective } | Assemble llms.txt for a site from its audited pages. |
| `llms-txt-generation.completed` | 1 | `llms-txt-generation.completed` | workers | orchestrator (`rex.orchestrator.results`) | { `cache`: ToolCallCacheList, `generation`: [LlmsTxtGeneration](../packages/contracts/openapi/services/llms-txt-generator.yaml), `pagesMissing`: integer } | The generated llms.txt, the pages that could not be read, and cache outcomes. |
| `llms-txt-generation.failed` | 1 | `llms-txt-generation.failed` | workers | orchestrator (`rex.orchestrator.results`) | `JobFailure` | The generation failed after all retries. |
<!-- GENERATED:catalog END -->

## Planned messages (no schema yet)

Added to events.yaml and topology.yaml when the job's phase starts; names are reserved.
Every job also gets its `.completed` and `.failed` siblings.

| Job (`<job>.requested`) | Phase | Worker flow (tools called) |
|---|---|---|
| `notification` | 6 | notifier (email, Slack, webhook) |
| `report-render` | 6 | report-renderer; output uploaded to a pre-signed URL from the job |
| `query-discovery` | 7 | query-discovery |
| `content-rewrite` | 7 | content-rewriter |
| `entity-audit` | 7 | entity-optimizer |
| `traffic-classification` | 7 | ai-traffic-analyzer |
| `structured-data-check` | 5 | the external [seo-auditor](services/seo-auditor.md) (no tool); added when its interface is known |

## Delivery

This section is the authority for delivery behavior.

- **Broker:** RabbitMQ 4.x, vhost `rex`, topic exchange `rex.events`. Each consumer has
  its own durable **quorum queue**; topology is declared only from topology.yaml.
- **Publishing (orchestrator):** transactional outbox. The state change and the outbox
  row commit together; the relay (any replica, rows claimed with `FOR UPDATE SKIP
  LOCKED`) publishes persistent messages on a confirm channel and marks rows sent only
  after the broker confirms. No message without a committed change, no committed change
  without a message.
- **Publishing (workers):** results are published on a confirm channel, and the job is
  acked only after the confirm. A crash in between redelivers the job, which can produce
  a duplicate result; the orchestrator drops it (below).
- **Consuming:** manual acks only. Prefetch per queue (topology.yaml) caps in-flight
  messages per consumer process; for answer capture this is the LLM concurrency cap per
  engine and worker replica.
- **Retries (configurable):** on a retryable failure (tool 429/503/timeout, network
  error) the worker republishes the message to `rex.retry` with routing key
  `<delay>.<queue>` and header `x-rex-attempt` + 1, then acks the original. The delay
  queue's TTL expires the message into `rex.requeue`, which routes it back to its queue.
  When the queue's delay sequence is used up, or on a non-retryable error (tool
  400/422), the worker publishes `<job>.failed`. Delays, retry counts and per-queue
  overrides are configuration (`retry` in topology.yaml, overlay
  `BUS_RETRY_OVERRIDES`); the current values are placeholders because the retry policy
  is [deferred](roadmap.md#deferred-decisions).
- **Dead letters:** messages that are rejected or exceed `x-delivery-limit` (crash loops
  and poison messages; value configurable, placeholder) go through `rex.dlx` to
  `rex.dead-letters`. Any depth above
  0 alerts; an operator re-drives after fixing the cause.
- **Dedupe:** at-least-once delivery means duplicates happen. The orchestrator records
  each processed message `id` in its inbox and applies at most one result per job
  `idempotencyKey` (job ledger), all in the same transaction as the result's writes.
  Workers are stateless and do not dedupe messages, but every tool call is cache first,
  so a duplicated, retried or redelivered job serves its finished steps from the cache
  and does not repeat their LLM calls (single-flight locks cover a job racing its own
  redelivery).
- **Ordering:** not guaranteed; nothing may depend on it. Run completion is decided by
  the job ledger counts, not by message order.
- **Size:** at most 8 MiB per message (`publish.maxMessageBytes` in topology.yaml,
  enforced by `packages/bus`). Larger artifacts (rendered reports) are uploaded by the
  worker to a pre-signed object-storage URL that the orchestrator puts in the job.
- **No replay:** acknowledged messages are gone. The orchestrator database is the source
  of truth; the job reconciler republishes jobs that have no result by their deadline
  (see [architecture.md#job-lifecycle](architecture.md#job-lifecycle)). RabbitMQ
  Streams can be added later if replay or audit history is needed.

## Versioning

- `version` in the envelope is the payload's major version; the routing key has no
  version. Producers and consumers are all in this repo, so changes use
  **expand and contract**: consumers learn to accept version N+1 and are deployed
  first, then producers switch, then support for N is removed.
- Non-breaking (same version): adding optional fields or enum values (consumers ignore
  unknown fields and values).
- Because payloads `$ref` tool schemas, a breaking change to a tool's request or response
  is a breaking change to its messages too; tool APIs are additive within `/v1`.
- Until the first producer and consumer exist, a breaking payload change keeps the
  message `version` and bumps only the events.yaml `info.version` major
  ([conventions §3](conventions.md#3-versioning)); example: 3.0.0, page results by
  reference.
- Page bodies never travel: page flows carry a `PageRef`
  ([page results by reference](architecture.md#page-results-by-reference)).

## Adding or changing a message

1. Add the job's three channels and messages to events.yaml (`x-rex-producers`,
   payload `$ref`s to tool schemas).
2. Add or extend the queue and bindings in topology.yaml.
3. Add the worker flow in `services/workers/src/flows/` and the orchestrator handler in
   the owning module.
4. Run codegen (`packages/bus` types and validators) and `gen-docs`.
