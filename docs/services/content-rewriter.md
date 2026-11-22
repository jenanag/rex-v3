# content-rewriter

- **Kind:** tool ([what that means](../architecture.md#service-map))
- **Phase:** 7
- **Contract:** `packages/contracts/openapi/services/content-rewriter.yaml`, written at the start of Phase 7, then vendored into `services/content-rewriter/contract/`
- **Language:** not chosen yet. [ADR 0024](../adr/0024-per-tool-language.md) proposes TypeScript: LLM-call bound; no library need outside npm. Its own language ADR, accepted by Jay, decides at the start of its phase (Phase 7).
- **Portability:** a self-contained project in its language: copy `services/content-rewriter/` anywhere, then its install, build, test and `docker build` work with nothing else present; no auth, no cache, no bus inside ([ADR 0018](../adr/0018-tool-portability.md))
- **State:** none (callers cache its results, see below)
- **Bus:** none

## Purpose

Rewrites page content to be easier for AI engines to quote and cite (answer-first
structure, entities, facts), given the page, the target prompts and audit issues.

## Endpoints

Defined when the Phase 7 contract is written: one or more `POST /v1/<noun>` operations following the [tool rules](../adr/0009-stateless-tool-services.md).

## Caching (by callers)

<!-- GENERATED:cache START (source: packages/contracts/cache/policy.yaml) -->
Caller cache policy: [policy.yaml](../../packages/contracts/cache/policy.yaml) ([ADR 0016](../adr/0016-cache-first.md)).

Policy entries arrive with the Phase 7 contract.
<!-- GENERATED:cache END -->

## Used by

- Worker flow `content-rewrite` (Phase 7).
