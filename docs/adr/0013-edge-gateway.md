# 0013: A thin edge gateway in front of the orchestrator and public tools

- **Status:** Accepted (2026-11-22, accepted by Jay)
- **Date:** 2026-11-22
- **Deciders:** Jay Pascual
- **Amended:** 2026-11-22: public tool calls are cache first ([ADR 0016](0016-cache-first.md)) (allowed while Proposed; see [README](README.md))
- **Amended:** 2026-11-22: tool portability ([ADR 0018](0018-tool-portability.md)) and internal packages ([ADR 0019](0019-internal-packages.md))
- **Amended:** 2026-11-22, at Jay's request: content extraction ([ADR 0021](0021-content-extraction.md))

## Context

With one orchestrator serving the API, a separate gateway is no longer needed for routing
between many services. But some free tools (crawler check, schema markup, llms.txt
validation) are pure tool calls, and the edge still needs TLS, API-key handling and
abuse protection.

## Decision

Keep a **separate, thin gateway** with no database and no bus:

- `/v1/tools/<tool path without /v1>` maps to tool operations marked `x-rex-public: true`
  (sync, LLM-free, taking already-extracted content; URL-based public flows are
  orchestrator endpoints, [ADR 0021](0021-content-extraction.md)). The gateway never
  calls the content-extractor. The gateway checks the cache first
  (`@rex/cache`, [ADR 0016](0016-cache-first.md)) and only on a miss calls the tool;
  tools have no auth of their own, so the gateway is their only path from the internet
  and routes nothing but `x-rex-public` operations ([ADR 0014](0014-auth.md));
  anonymous callers are rate limited per IP.
- Every other `/v1` path goes to the orchestrator. Bearer tokens are verified with the
  cached JWKS; `X-API-Key` is exchanged at the orchestrator for a token of at most 5
  minutes (cached in the `redis-edge` instance); inbound `X-Rex-*` headers are stripped.
- Rate limits per org (plan) and per IP live in `redis-edge`; tool results are cached in
  `redis-cache`, shared with the workers.
- The route table is generated from the specs.
- Async free tools (audits, llms.txt generation) are orchestrator endpoints that allow
  anonymous callers, because they need jobs and storage.

## Consequences

- Public sync tools never load the orchestrator or database, so abuse stays at the edge
  and the tools scale independently.
- The orchestrator stays focused on product API and state.
- One more deployable, but with no state of its own.

## Alternatives considered

- **No gateway; orchestrator is the edge**: simpler, but anonymous tool traffic and rate
  limiting would hit the stateful service, and the orchestrator would have to proxy tools,
  breaking "the orchestrator never calls tools".
- **Off-the-shelf gateway (Kong, Envoy, a cloud API gateway)**: viable for the routing
  and rate limits; the API-key exchange and generated routes still need custom glue.
  Revisit in Phase 8.
