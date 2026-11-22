# gateway

- **Kind:** gateway ([what that means](../architecture.md#service-map))
- **Phase:** 3
- **Contract:** [packages/contracts/openapi/services/gateway.yaml](../../packages/contracts/openapi/services/gateway.yaml) (vendored into the service from Phase 3)
- **State:** none of its own; `redis-edge` for rate limits and token cache, shared tool-result cache `redis-cache`
- **Bus:** none

## Purpose

The thin edge: TLS termination, auth resolution, rate limits and routing
([ADR 0013](../adr/0013-edge-gateway.md)). Holds no business logic, no database and no
bus connection. Flow: [architecture.md#gateway-flow](../architecture.md#gateway-flow).

## Routing

- `/v1/tools/<tool path without /v1>` goes to the tool operations marked
  `x-rex-public: true` (listed below). **Cache first:** `@rex/cache` looks the call
  up in `redis-cache` and only on a miss calls the tool, without a token (tools have no
  auth, [ADR 0014](../adr/0014-auth.md); [ADR 0016](../adr/0016-cache-first.md)).
  Public tool operations take content, not URLs to fetch; URL-based public flows are
  orchestrator endpoints (e.g. `createAudit`). The gateway never calls the
  content-extractor ([ADR 0021](../adr/0021-content-extraction.md)). Responses carry `X-Rex-Cache` and, on
  hits, `X-Rex-Cached-At`; `Cache-Control: no-cache` forces a refresh and counts double
  against the rate limit.
- Every other `/v1/...` path goes to the orchestrator.
- `/internal/...` is never exposed.

The table is generated from the specs by `scripts/gen-gateway-routes`.

## Endpoints

<!-- GENERATED:endpoints START (source: packages/contracts/openapi/services/gateway.yaml) -->
Public tool routes (anonymous, rate limited per IP):
- `POST /v1/tools/crawler-checks` to content-auditor `checkCrawlerAccess`
- `POST /v1/tools/llms-txt/validate` to llms-txt-generator `validateLlmsTxt`
- `POST /v1/tools/schema-markup` to schema-generator `generateSchemaMarkup`
- `POST /v1/tools/schema-markup/validate` to schema-generator `validateSchemaMarkup`
- `GET /healthz`, `GET /readyz`: shared probes
<!-- GENERATED:endpoints END -->

## State and dependencies

- `redis-edge` (gateway only, `noeviction`): rate-limit counters per org and per IP, and
  the cache of exchanged API-key tokens (at most 5 minutes).
- `redis-cache` (shared with workers): tool results, via `@rex/cache`. Public calls
  are anonymous, so they use shared entries only (no customer overrides).
- Orchestrator identity: JWKS (cached), `exchangeApiKey`, `createServiceToken`.
- Tools are called without a token (they have no auth; NetworkPolicy admits the gateway).
- Packages: `@rex/cache` (pinned, [ADR 0019](../adr/0019-internal-packages.md)); public: `fastify`, `@fastify/http-proxy`, `@fastify/rate-limit`, `jose`, `ioredis`, `openapi-fetch`.
- Vendored contracts ([vendoring.yaml](../../packages/contracts/vendoring.yaml)): own spec, orchestrator spec, public tool specs, cache policy.

## Notes

- Anonymous limits per IP apply to `/v1/tools/...` and to anonymous orchestrator
  operations (audits, llms.txt); signed-in limits come from the org's plan.
