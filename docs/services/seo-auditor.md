# seo-auditor

- **Kind:** external ([what that means](../architecture.md#service-map))
- **Phase:** 5
- **Contract:** not known yet: owned and implemented outside this repo; REx adds `packages/contracts/openapi/services/seo-auditor.yaml` once the interface is decided with its owner ([deferred decisions](../roadmap.md#deferred-decisions)) and vendors it into workers like the content-extractor's
- **State:** unknown (owned outside REx); REx stores only the results it receives
- **Bus:** none

## Purpose

Checks the **structured data of a URL** (JSON-LD and other markup a page carries) for
REx. It is Jay's existing **SEO auditor service**, repurposed for this; it is owned and
implemented outside this repo ([ADR 0021](../adr/0021-content-extraction.md),
amendment of 2026-11-22). This is REx's URL-based structured-data flow:
schema-generator keeps taking HTML or data and never fetches.

## How REx will use it

Routed exactly like the [content-extractor](content-extractor.md):

1. The orchestrator's `optimization` module accepts a URL (a new async endpoint, like
   `createAudit`) and publishes a job through its outbox.
2. A worker consumes the job, calls the seo-auditor (cache first, if its results are
   cacheable) and publishes `.completed` or `.failed`.
3. The orchestrator stores the result with the resource.

The job name `structured-data-check` is reserved
([planned messages](../events.md#planned-messages-no-schema-yet)). The endpoint, the
messages, the topology entry, the cache policy entry and the worker flow are added
when the seo-auditor's interface is known; nothing is defined before that.

## Who calls it

- **Workers only.** Never the orchestrator, the gateway or any tool.

## Not known yet

Listed in the [deferred decisions](../roadmap.md#deferred-decisions); none is guessed
here: its endpoint, request and response shapes, error format, auth and where it runs,
whether it fetches the URL itself or takes the content-extractor's output, its time and
size limits, whether its results can be cached (and for how long), its version scheme,
and whether its findings overlap content-auditor's `structured_data` category.

## Configuration

- Callers: `SEO_AUDITOR_URL` in workers only ([conventions §12](../conventions.md#12-environment-variables)).
