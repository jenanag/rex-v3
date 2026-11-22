# report-renderer

- **Kind:** tool ([what that means](../architecture.md#service-map))
- **Phase:** 6
- **Contract:** `packages/contracts/openapi/services/report-renderer.yaml`, written at the start of Phase 6, then vendored into `services/report-renderer/contract/`
- **Language:** not chosen yet. [ADR 0024](../adr/0024-per-tool-language.md) proposes TypeScript: HTML and PDF rendering, best supported by the Node headless-browser tooling. Its own language ADR, accepted by Jay, decides at the start of its phase (Phase 6).
- **Portability:** a self-contained project in its language: copy `services/report-renderer/` anywhere, then its install, build, test and `docker build` work with nothing else present; no auth, no cache, no bus inside ([ADR 0018](../adr/0018-tool-portability.md))
- **State:** none (callers cache its results, see below)
- **Bus:** none

## Purpose

Renders a report (PDF or HTML, white-label) from data supplied in the request and
uploads it to the pre-signed URL the job provides, so large files never travel on the
bus. Report definitions and schedules live in the orchestrator.

## Endpoints

Defined when the Phase 6 contract is written: one or more `POST /v1/<noun>` operations following the [tool rules](../adr/0009-stateless-tool-services.md).

## Caching (by callers)

<!-- GENERATED:cache START (source: packages/contracts/cache/policy.yaml) -->
Caller cache policy: [policy.yaml](../../packages/contracts/cache/policy.yaml) ([ADR 0016](../adr/0016-cache-first.md)).

Policy entries arrive with the Phase 6 contract.
<!-- GENERATED:cache END -->

## Used by

- Worker flow `report-render` (Phase 6).
