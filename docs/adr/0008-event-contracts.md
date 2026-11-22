# 0008: Event contracts and delivery

- **Status:** Superseded by [0012](0012-bus-contracts.md) (2026-11-22); kept unchanged below as history
- **Date:** 2026-11-22
- **Deciders:** Jay Pascual

## Context

Services react to each other's changes (answers captured, brands edited, schedules due).
Events need one contract source, reliable delivery without distributed transactions,
fan-out to several consumers, and safe evolution.

## Decision

- **Contract:** `packages/contracts/asyncapi/events.yaml` (AsyncAPI 3.1) is the only
  definition of events: channel per event and major version, `x-rex-producers`,
  `x-rex-consumers`, payload schema. Payloads that carry a resource `$ref` the producer's
  OpenAPI schema. `packages/events` generates TS types and Ajv validators from it; no Zod
  or hand-written duplicates. [events.md](../events.md) is the generated catalog.
- **Envelope:** one shared `EventEnvelope` schema in events.yaml (ID, type, version,
  time, producer, tenant, trace context, `data`).
- **Naming:** `<entity>.<past_tense_verb>`; events are facts, never commands.
- **Delivery:** transactional outbox in the producer's schema, relay to Redis Streams,
  one consumer group per consuming service, at-least-once with an inbox table for
  idempotency, dead-letter streams, and bounded retention. Exact parameters live in
  [events.md#delivery](../events.md#delivery).
- **Versioning:** additive changes keep the version; breaking changes publish a new
  version in parallel until consumers move (rules in events.md).
- Producers validate outgoing payloads and consumers validate incoming ones in
  non-production environments; production validates on publish only.

## Consequences

- No lost or phantom events; consumers can be added later without producer changes.
- Consumers must be idempotent and tolerate reordering across streams.
- Redis Streams retention limits replay to days (see ADR 0004 for the upgrade path).

## Alternatives considered

- **Zod schemas in packages/events as the source**: TypeScript-only and a second schema
  language next to the OpenAPI JSON Schemas; cannot `$ref` the REST resources.
- **JSON Schema files without AsyncAPI**: works, but loses the standard catalog of
  channels, producers and consumers and its tooling.
- **Thin events only (IDs) with callbacks to the producer**: simpler payloads, but adds
  synchronous coupling and load for every consumer of high-volume events like
  `answer.captured`.
