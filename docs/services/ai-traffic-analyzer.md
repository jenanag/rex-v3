# ai-traffic-analyzer

- **Kind:** tool ([what that means](../architecture.md#service-map))
- **Phase:** 7
- **Contract:** `packages/contracts/openapi/services/ai-traffic-analyzer.yaml`, written at the start of Phase 7, then vendored into `services/ai-traffic-analyzer/contract/`
- **Language:** not chosen yet. [ADR 0024](../adr/0024-per-tool-language.md) proposes Go: parsing large log batches fast with low memory. Its own language ADR, accepted by Jay, decides at the start of its phase (Phase 7).
- **Portability:** a self-contained project in its language: copy `services/ai-traffic-analyzer/` anywhere, then its install, build, test and `docker build` work with nothing else present; no auth, no cache, no bus inside ([ADR 0018](../adr/0018-tool-portability.md))
- **State:** none (callers cache its results, see below)
- **Bus:** none

## Purpose

Classifies a batch of web log lines or analytics rows into AI crawler and AI referral
traffic using the shared [crawler list](../../packages/contracts/data/ai-crawlers.yaml),
returning per-crawler and per-page counts. Storage and trends live in the orchestrator.

## Endpoints

Defined when the Phase 7 contract is written: one or more `POST /v1/<noun>` operations following the [tool rules](../adr/0009-stateless-tool-services.md).

## Caching (by callers)

<!-- GENERATED:cache START (source: packages/contracts/cache/policy.yaml) -->
Caller cache policy: [policy.yaml](../../packages/contracts/cache/policy.yaml) ([ADR 0016](../adr/0016-cache-first.md)).

Policy entries arrive with the Phase 7 contract.
<!-- GENERATED:cache END -->

## Used by

- Worker flow `traffic-classification` (Phase 7).
