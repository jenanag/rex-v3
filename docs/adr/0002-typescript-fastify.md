# 0002: TypeScript on Node.js with Fastify

- **Status:** Accepted (2026-11-22, accepted by Jay)
- **Date:** 2026-11-22
- **Deciders:** Jay Pascual
- **Amended:** 2026-11-22, for the stateless-tools redesign (allowed while Proposed; see [README](README.md))
- **Amended:** 2026-11-22: tool portability ([ADR 0018](0018-tool-portability.md)) and internal packages ([ADR 0019](0019-internal-packages.md))
- **Amended by:** [0024](0024-per-tool-language.md), 2026-11-22 (accepted by Jay): TypeScript and Fastify stay the platform language and the default tool language; a tool may be Python or Go, chosen in its own ADR

## Context

Most service work is I/O: HTTP, Postgres, RabbitMQ and LLM APIs. The dashboard is Next.js.
One language across apps, services and generated clients avoids duplicated types.

## Decision

- TypeScript (strict) on the current Node.js Active LTS, pinned in `.nvmrc` and
  `engines` during Phase 1. ESM only.
- Fastify for every HTTP service (gateway, orchestrator, tools) with public plugins
  only. Tools get their bootstrap (Ajv configured for JSON Schema 2020-12, problem+json
  errors, health probes, OpenTelemetry) from `services/_template`
  ([ADR 0018](0018-tool-portability.md)); platform services own theirs. Routes are
  bound to `operationId`s from the service's vendored, bundled `openapi.yaml`; the spec
  is the request validator, not hand-written route schemas.
- Pure domain code in `src/domain` with no framework imports.

## Consequences

- Types for requests, responses and SDK clients all come from the specs.
- Need a Phase 1 spike to confirm Fastify + Ajv 2020 handles our 3.1 features
  (`unevaluatedProperties`, `type: [x, "null"]`) after bundling.
- Slow work (LLM chains, rendering, PDF) runs as bus jobs driven by workers; tool
  handlers stay simple request/response.

## Alternatives considered

- **Hono**: lighter and edge-friendly, but a thinner plugin ecosystem for the Node
  services we run (OpenTelemetry, rate limiting, proxying).
- **NestJS**: more structure but heavier, decorator-driven, and pulls toward
  code-first contracts.
- **Python (FastAPI)**: good LLM tooling, but a second language next to the TS dashboard
  and SDK.
