# 0019: Internal packages: only where unavoidable, published and pinned

- **Status:** Accepted (2026-11-22, accepted by Jay)
- **Date:** 2026-11-22
- **Deciders:** Jay Pascual
- **Amends:** [0001](0001-monorepo-pnpm-turborepo.md), [0007](0007-dry-policy.md)
- **Amended:** 2026-11-22, at Jay's request: tools never fetch, so the template has no fetch helper ([ADR 0021](0021-content-extraction.md))
- **Amended by:** [0024](0024-per-tool-language.md), 2026-11-22 (accepted by Jay): the no-internal-packages rule applies to tools in every language (no private Python package index or private Go module either)

## Context

The first design had about a dozen internal packages, linked with `workspace:*`. Under
[ADR 0018](0018-tool-portability.md) tools use none of them, and Jay asked to avoid
internal packages whenever a public one or a generated file does the job.

## Decision

An internal package exists only when two or more services must run **identical
behavior** and a mismatch would corrupt data or break delivery. Each one is published to
the private npm registry (GitHub Packages, scope `@rex`) with semver and Changesets,
and every consumer pins an exact version. No `workspace:` links from services, so a
service builds the same way inside and outside the repo. Tools may not depend on any
internal package.

| Package | Consumers | Why it cannot be avoided |
|---|---|---|
| `packages/contracts` (not an npm package) | none at runtime; copied by `scripts/vendor-contracts` | the single source of every contract ([dry-rule.md](../dry-rule.md)); consumers get vendored copies |
| `@rex/cache` (`packages/cache`) | workers, gateway | both must derive byte-identical cache keys, apply the same override resolution and single-flight protocol from [policy.yaml](../../packages/contracts/cache/policy.yaml); two implementations would split the cache or serve wrong entries ([ADR 0016](0016-cache-first.md)) |
| `@rex/bus` (`packages/bus`) | orchestrator, workers | producer and consumer must agree on envelope validation, topology declaration from topology.yaml, publisher confirms, retry routing and dead-lettering; a mismatch loses or duplicates jobs ([ADR 0012](0012-bus-contracts.md)). Built on `amqplib`; adopting `rascal` underneath is evaluated in Phase 4 |

Removed, and what replaces them:

| Was | Now |
|---|---|
| `@rex/http` | Fastify + public plugins; tools get bootstrap from `services/_template`, platform services own theirs |
| `@rex/auth` | tools: nothing (no auth inside); gateway and orchestrator use `jose` directly |
| `@rex/config` | `env-schema` per service; root tsconfig/ESLint/Prettier files for platform code, template copies for tools |
| `@rex/observability` | `pino` + `@opentelemetry/sdk-node` per service (template for tools) |
| `@rex/llm-clients` | official SDKs behind a per-tool adapter from the template |
| `@rex/scraper` | not needed: the external content-extractor reads websites; tools only parse what they are given (`cheerio`, `robots-parser`) |
| `@rex/sdk` | each consumer generates its own clients from its vendored specs (`openapi-typescript` + `openapi-fetch`) |
| `@rex/db-client` | code inside the orchestrator (its only user) |
| `@rex/ui` | inside the dashboard app (its only user) |

Adding a package needs a new ADR that shows the identical-behavior argument above.

## Consequences

- Platform services can also be built from their own folder with registry access only.
- Releasing `@rex/cache` or `@rex/bus` is a deliberate step; consumers upgrade in the
  same PR as a pinned bump (Renovate opens it). Mixed versions in production are allowed
  only when the package's changelog says the wire format is unchanged.
- A private registry and a CI token are needed from Phase 3 (first `@rex/cache` user).

## Alternatives considered

- **`workspace:*` for platform packages**: simpler locally, but builds then depend on
  the repo layout and upgrades are implicit.
- **No internal packages at all (copy cache and bus code)**: two implementations of the
  same key derivation or delivery protocol is exactly the drift that loses data.
