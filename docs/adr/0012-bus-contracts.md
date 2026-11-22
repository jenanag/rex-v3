# 0012: Bus contracts: AsyncAPI messages and one topology file

- **Status:** Accepted (2026-11-22, accepted by Jay)
- **Date:** 2026-11-22
- **Deciders:** Jay Pascual
- **Amended:** 2026-11-22: cache directive and cache outcomes in job messages (allowed while Proposed; see [README](README.md))
- **Supersedes:** [0008](0008-event-contracts.md)
- **Amended:** 2026-11-22: tool portability ([ADR 0018](0018-tool-portability.md)) and internal packages ([ADR 0019](0019-internal-packages.md))

## Context

Bus messages and broker topology must be defined once, validated in CI, and generated
into typed code, like the REST contracts.

## Decision

- [`asyncapi/events.yaml`](../../packages/contracts/asyncapi/events.yaml) (AsyncAPI
  3.1) defines every message: channel address = routing key, `x-rex-producers`, a shared
  `Envelope` (`id`, `type`, `version`, `occurredAt`, `producer`, `orgId`, `projectId`,
  `idempotencyKey`, `causationId`, `traceparent`, `data`) and the payload. Channels carry
  AMQP bindings that `$ref` the exchange in topology.yaml.
- [`bus/topology.yaml`](../../packages/contracts/bus/topology.yaml) defines exchanges,
  queues, bindings, prefetch, the configurable retry policy and dead-lettering. Both
  files are vendored into the orchestrator and workers and applied by `@rex/bus`
  ([ADR 0019](0019-internal-packages.md)). **Consumers are derived from
  queue bindings**, never listed in AsyncAPI, so who-consumes-what has one source.
- Payloads are **tool inputs and outputs by `$ref`**: requested = tool request,
  completed = tool response, failed = `JobFailure`. Two additions are not tool
  data: `requested` messages may carry `cache` (`CacheDirective`) and `completed`
  messages carry `cache` (`ToolCallCacheList`, one outcome per tool call), both from
  common.yaml ([ADR 0016](0016-cache-first.md)). Subjects are mapped by idempotency key
  in the orchestrator, not carried in payloads.
- Versioning: `version` in the envelope, not in the routing key; expand-and-contract
  rollouts because all producers and consumers live in this monorepo.
- `packages/bus` generates types and validators from events.yaml; docs/events.md has a
  generated catalog joining both files; `check-contracts` fails when routing keys and
  bindings disagree.
- Schemas shared with AsyncAPI use `oneOf` + `const`, never `discriminator`.

## Consequences

- Adding a job is three edits in two contract files plus code, all checked in CI.
- Tool schema changes ripple into messages automatically; tool APIs must stay additive.

## Alternatives considered

- **Consumers listed in AsyncAPI**: duplicates the topology, which is what actually routes.
- **Versioned routing keys (`.v1`)**: needs parallel queues per version; unnecessary with
  one repo and expand/contract.
- **Thin events with IDs only**: workers would need to call back for data, adding state
  and coupling.
