# 0003: Postgres with schema-per-service ownership

- **Status:** Superseded by [0010](0010-orchestrator.md) (2026-11-22); kept unchanged below as history
- **Date:** 2026-11-22
- **Deciders:** Jay Pascual

## Context

Microservices must own their data so they can change and deploy independently. A
database cluster per service is expensive and operationally heavy for an early product.

## Decision

- One managed Postgres cluster (one per environment). Each service owns exactly one
  schema named after it (`prompt-tracker` becomes `prompt_tracker`) and connects with its
  own role that has privileges only on that schema.
- Each service keeps its migrations in `services/<name>/migrations/` and runs them
  itself. `packages/db-client` provides the pool, transactions, migration runner and
  per-transaction org context for row-level security; it contains no table definitions.
- No cross-schema queries, views, foreign keys or joins. Data from other services comes
  through REST, events, or local read models fed by events.
- Row-level security on `org_id` for every tenant table.
- A service that outgrows the shared cluster moves to its own cluster without code
  changes (only `DATABASE_URL` changes).

## Consequences

- Cheap to run, simple backups, real ownership boundaries enforced by grants.
- Reporting across services needs events or read models (or a warehouse later).
- One noisy service can affect others on the shared cluster; watch and split when needed.

## Alternatives considered

- **Database per service**: strongest isolation, highest cost and ops load now.
- **Shared schema with table prefixes**: no grant boundary; invites cross-service joins.
- **Shared `packages/db` with all schemas**: couples every service to every table change.
