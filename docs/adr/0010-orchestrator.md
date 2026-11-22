# 0010: One stateful orchestrator (modular monolith)

- **Status:** Accepted (2026-11-22, accepted by Jay)
- **Date:** 2026-11-22
- **Deciders:** Jay Pascual
- **Supersedes:** [0003](0003-postgres-schema-per-service.md)

## Context

With tools stateless ([ADR 0009](0009-stateless-tool-services.md)), all state must live
somewhere: accounts and tenancy, brands and projects, tracking results, schedules,
billing and usage, alerts, and the job bookkeeping that ties async work together.

## Decision

- One **orchestrator** service is the only database owner and writer (Postgres, plus
  object storage). It exposes the dashboard and public API (behind the gateway), owns
  schedules, publishes jobs and consumes results.
- Inside it is a **modular monolith**: modules `identity`, `catalog`, `tracking`,
  `optimization`, `scheduling`, `billing`, `alerts`, `messaging`. Each owns one Postgres
  schema and its migrations and exposes only its `index.ts`; dependency-cruiser forbids
  reaching into another module. A request may use one transaction across modules.
- **Safe with 2+ replicas without leader election**: every background loop (scheduler
  tick, outbox relay, job reconciler) claims rows with `FOR UPDATE SKIP LOCKED`;
  schedule firings are unique on `(schedule_id, scheduled_for)`. Details:
  [architecture.md](../architecture.md#scheduling-with-2-orchestrator-replicas).
- The orchestrator never calls tools; anything needing a tool becomes a job.
- Roles (API, loops) run in every replica by default and can be split later with
  `ORCHESTRATOR_ROLES` without code changes.

## Consequences

- One place for transactions, tenancy, RLS and consistency; no distributed sagas.
- A module boundary is cheaper to change than a service boundary; a module can still be
  extracted later because its schema and interface are already separate.
- The orchestrator is the critical path for the API; it must scale horizontally (it is
  stateless between requests) and the database becomes the main scaling limit.

## Alternatives considered

- **Keep platform microservices (accounts, scheduler, billing...)**: more deployables and
  cross-service consistency problems for no current scaling need.
- **Leader election (advisory lock or Kubernetes lease) for the scheduler**: works, but
  `SKIP LOCKED` spreads load and needs no failover logic.
- **External scheduler (Kubernetes CronJobs, Temporal)**: schedules are tenant data that
  change at runtime; keeping them in the DB keeps one source of truth.
