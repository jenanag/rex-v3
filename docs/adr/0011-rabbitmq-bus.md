# 0011: RabbitMQ (self-hosted) as the job bus

- **Status:** Accepted (2026-11-22, accepted by Jay)
- **Date:** 2026-11-22
- **Deciders:** Jay Pascual
- **Supersedes:** [0004](0004-redis-bullmq-queues.md)
- **Amended:** 2026-11-22: self-hosted decided; retry policy made configurable (values deferred); Redis moved to [0016](0016-cache-first.md) (allowed while Proposed; see [README](README.md))
- **Amended:** 2026-11-22: tool portability ([ADR 0018](0018-tool-portability.md)) and internal packages ([ADR 0019](0019-internal-packages.md))

## Context

The orchestrator hands slow, retryable, LLM-bound work to stateless workers and receives
results. We need durable delivery, per-engine concurrency caps, delayed retries,
dead-lettering and publisher acknowledgements, with no state in workers.

## Decision

- **RabbitMQ 4.x, self-hosted** (vhost `rex`), client **amqplib** wrapped once in
  `@rex/bus` (`packages/bus`, [ADR 0019](0019-internal-packages.md)).
- Topic exchange `rex.events`; routing keys `<job>.<requested|completed|failed>[.<shard>]`.
- One durable **quorum queue** per consumer and job, manual acks, per-queue **prefetch**
  (caps LLM concurrency), an `x-delivery-limit` crash-loop guard, dead-lettering
  `at-least-once` to the fanout `rex.dlx` and the `rex.dead-letters` queue.
- **Delayed retries, configurable:** the mechanism is fixed (per-delay TTL queues
  `rex.retry.<delay>` on `rex.retry` that dead-letter into `rex.requeue`, which routes
  back to the source queue). The policy (delay pool, per-attempt delays and so the retry
  count, per-queue overrides, delivery limit) is configuration in
  [`bus/topology.yaml`](../../packages/contracts/bus/topology.yaml) with per-environment
  overrides. Current values are placeholders: the policy is
  [deferred](../roadmap.md#deferred-decisions).
- **Orchestrator transactional outbox + relay** with publisher confirms; workers publish
  results with confirms before acking the job.
- **At-least-once** delivery with dedupe by message id (inbox) and job idempotency key
  (job ledger) in the orchestrator. Repeated tool calls on redelivery are absorbed by
  the cache ([ADR 0016](0016-cache-first.md)).
- Topology is defined once in topology.yaml and declared by `@rex/bus`.
- **Replay limitation:** acked messages are gone. The database is the source of truth and
  the reconciler republishes stuck jobs. RabbitMQ Streams can be added later for replay.

Deliberate deviation from the brief's example (`prompt-run.requested`): jobs are per
answer (`answer-capture.requested.<engine>`), because a whole prompt run is too coarse
to retry and cannot be capped per engine by prefetch.

## Self-hosting: operational implications

- **Production:** a 3-node cluster (quorum queues need a majority: survives one node
  loss), one node per availability zone, persistent volumes, deployed with the RabbitMQ
  Cluster Kubernetes Operator (Phase 8). Upgrades are rolling, one node at a time, after
  checking feature flags.
- **Development:** a single node in `docker compose` with the same topology (quorum
  queues work on one node; no replication). Topology is applied by `rex-bus declare`
  in both.
- **Delayed retries** use only core features (TTL + dead-lettering): no delayed-message
  plugin to install, upgrade or back up.
- **Monitoring:** the built-in Prometheus endpoint (`rabbitmq_prometheus`) scraped into
  Grafana; alerts on queue depth and age per queue, `rex.dead-letters` depth > 0,
  unacked counts, publisher confirm latency, memory and disk alarms (which block
  publishers), node down and quorum members unavailable. The management UI stays
  internal.
- **Capacity and safety:** memory high watermark and disk free limit set explicitly;
  quorum queue `x-overflow: reject-publish` surfaces back-pressure to publishers
  instead of dropping messages; the outbox absorbs broker outages on the producer side.
- **Backups:** definitions (topology, users, policies) are exported from git-held
  topology.yaml; message contents are not backed up (the database is the source of truth
  and the reconciler republishes).
- **Security:** TLS between clients and nodes, one user per service kind (orchestrator,
  workers) with permissions limited to their exchanges and queues.

## Consequences

- Mature broker semantics (acks, confirms, DLX, quorum replication) instead of
  hand-built ones.
- We operate the cluster ourselves: on-call knowledge, upgrades and monitoring are ours,
  in exchange for no vendor cost or lock-in and identical dev and prod behavior.
- No message history; investigations use the job ledger and logs.

## Alternatives considered

- **Managed RabbitMQ (CloudAMQP, Amazon MQ)**: less ops, but recurring cost, plan limits
  and less control over versions and policies.
- **Redis Streams + BullMQ** (v1): workable but retries, DLQ and confirms are library
  conventions on a cache-oriented store.
- **Kafka / Redpanda**: replay and throughput we do not need; weaker per-message retry and
  per-consumer concurrency semantics for job work.
- **Postgres as the queue (SKIP LOCKED jobs)**: fewer moving parts, but workers would need
  database access, which breaks [ADR 0015](0015-stateless-workers.md).
- **NATS JetStream**: capable, smaller ecosystem and team familiarity than RabbitMQ.
- **Delayed-message exchange plugin** for retries: simpler topology, but a plugin with
  known scaling limits and no replication.
