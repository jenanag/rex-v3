# 0004: Redis with BullMQ for jobs

- **Status:** Superseded by [0011](0011-rabbitmq-bus.md) (2026-11-22); kept unchanged below as history
- **Date:** 2026-11-22
- **Deciders:** Jay Pascual

## Context

LLM calls take seconds to minutes, are rate limited per provider, fail transiently and
cost money. Crawls and report rendering are also slow. None of this can run inside an
HTTP request.

## Decision

- Redis (managed, one per environment) is the queue and event backbone.
- **Jobs** (work inside one service) use BullMQ through `packages/queue`, which gives
  retries with backoff, per-queue rate limiters and concurrency, and job-ID idempotency.
  Queue naming is in [conventions.md](../conventions.md#1-naming); the retry and
  retention policy is in [architecture.md](../architecture.md#llm-concurrency-and-cost).
- **Events** (facts other services react to) use Redis Streams through
  `packages/events`, not BullMQ, because BullMQ queues deliver each job to one consumer
  and events need fan-out to several consumer groups. See [ADR 0008](0008-event-contracts.md).
- Recurring schedules: the scheduler's Postgres table is the source of truth;
  BullMQ job schedulers are reconciled from it.
- Redis must run with persistence (AOF) and `maxmemory-policy noeviction`.

## Consequences

- One infrastructure dependency for jobs, events, rate limits and caches.
- Redis is not a long-term log: event retention is days, not months. If REx needs
  replay over months or very high throughput, move events to NATS JetStream or Kafka
  behind the same `packages/events` interface.

## Alternatives considered

- **RabbitMQ**: good routing and fan-out, but a second broker next to Redis.
- **Kafka**: durable log and replay, too heavy for the early stage.
- **Postgres-based queues (pg-boss, Graphile Worker)**: fewer moving parts, but weaker
  rate limiting per queue and adds load to the shared database.
- **BullMQ for events too**: needs one queue per consumer and fan-out code; Streams do
  this natively.
