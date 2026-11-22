# orchestrator

- **Kind:** orchestrator ([what that means](../architecture.md#service-map))
- **Phase:** 3
- **Contract:** [packages/contracts/openapi/services/orchestrator.yaml](../../packages/contracts/openapi/services/orchestrator.yaml) (vendored into the service from Phase 3)
- **State:** Postgres (all platform data, sole writer) and object storage
- **Bus:** publishes jobs, consumes results

## Purpose

The only stateful service ([ADR 0010](../adr/0010-orchestrator.md)): the dashboard and
public API, all data, schedules, and the job bus producer and result consumer. A modular
monolith; each module owns one Postgres schema
([data ownership](../architecture.md#data-ownership)).

## Modules

| Module | Phase | Responsibility |
|---|---|---|
| `identity` | 3 | users, orgs, members, API keys, token issuing, signing keys and JWKS; org settings, including per-customer cache overrides |
| `catalog` | 3 | projects and brands; builds `TrackedBrand` lists for jobs |
| `tracking` | 4 | prompts, prompt runs, answers, mentions, citations, visibility aggregates |
| `scheduling` | 4 | schedules and the 15 s tick ([how](../architecture.md#scheduling-with-2-orchestrator-replicas)) |
| `optimization` | 5 | audits and llms.txt generations (pipeline state, page rows with their cache keys); Phase 7 optimization results |
| `messaging` | 3/4 | HTTP idempotency; outbox relay, inbox, job ledger, reconciler ([delivery](../events.md#delivery)) |
| `billing` | 6 | plans, Stripe, entitlements, usage metering from tool `usage` |
| `alerts` | 6 | alert rules and channels; sends through `notification` jobs |

## Background loops

All run in every replica and claim rows with `FOR UPDATE SKIP LOCKED`: scheduler tick,
outbox relay, result consumer, job reconciler, run finalizer (aggregates and alerts when
all jobs of a run are terminal).

## Endpoints

<!-- GENERATED:endpoints START (source: packages/contracts/openapi/services/orchestrator.yaml) -->
- **Auth**
  - `POST /v1/auth/signup`: `signup`
  - `POST /v1/auth/login`: `login`
  - `POST /v1/auth/refresh`: `refreshTokens`
  - `POST /v1/auth/logout`: `logout`
  - `GET /v1/me`: `getMe`
- **Orgs**
  - `GET /v1/orgs`: `listOrgs`
  - `GET /v1/orgs/{orgId}`: `getOrg`
  - `PATCH /v1/orgs/{orgId}`: `updateOrg`
  - `DELETE /v1/orgs/{orgId}`: `deleteOrg`
  - `GET /v1/orgs/{orgId}/members`: `listOrgMembers`
- **API keys**
  - `GET /v1/api-keys`: `listApiKeys`
  - `POST /v1/api-keys`: `createApiKey`
  - `DELETE /v1/api-keys/{apiKeyId}`: `revokeApiKey`
- **Projects**
  - `GET /v1/projects`: `listProjects`
  - `POST /v1/projects`: `createProject`
  - `GET /v1/projects/{projectId}`: `getProject`
  - `PATCH /v1/projects/{projectId}`: `updateProject`
  - `DELETE /v1/projects/{projectId}`: `deleteProject`
- **Brands**
  - `GET /v1/brands`: `listBrands`
  - `POST /v1/brands`: `createBrand`
  - `GET /v1/brands/{brandId}`: `getBrand`
  - `PATCH /v1/brands/{brandId}`: `updateBrand`
  - `DELETE /v1/brands/{brandId}`: `deleteBrand`
- **Prompts**
  - `GET /v1/prompts`: `listPrompts`
  - `POST /v1/prompts`: `createPrompt`
  - `GET /v1/prompts/{promptId}`: `getPrompt`
  - `PATCH /v1/prompts/{promptId}`: `updatePrompt`
  - `DELETE /v1/prompts/{promptId}`: `deletePrompt`
- **Prompt runs**
  - `GET /v1/prompt-runs`: `listPromptRuns`
  - `POST /v1/prompt-runs`: `createPromptRun`
  - `GET /v1/prompt-runs/{promptRunId}`: `getPromptRun`
  - `POST /v1/prompt-runs/{promptRunId}/cancel`: `cancelPromptRun`
- **Answers**
  - `GET /v1/answers`: `listAnswers`
  - `GET /v1/answers/{answerId}`: `getAnswer`
- **Visibility**
  - `GET /v1/mentions`: `listMentions`
  - `GET /v1/visibility/summary`: `getVisibilitySummary`
  - `GET /v1/visibility/timeseries`: `getVisibilityTimeseries`
- **Citations**
  - `GET /v1/citations`: `listCitations`
  - `GET /v1/citations/domains`: `listCitedDomains`
- **Schedules**
  - `GET /v1/schedules`: `listSchedules`
  - `POST /v1/schedules`: `createSchedule`
  - `GET /v1/schedules/{scheduleId}`: `getSchedule`
  - `PATCH /v1/schedules/{scheduleId}`: `updateSchedule`
  - `DELETE /v1/schedules/{scheduleId}`: `deleteSchedule`
  - `POST /v1/schedules/{scheduleId}/trigger`: `triggerSchedule`
- **Audits**
  - `GET /v1/audits`: `listAudits`
  - `POST /v1/audits`: `createAudit`
  - `GET /v1/audits/{auditId}`: `getAudit`
- **llms.txt**
  - `GET /v1/llms-txt`: `listLlmsTxt`
  - `POST /v1/llms-txt`: `createLlmsTxt`
  - `GET /v1/llms-txt/{llmsTxtId}`: `getLlmsTxt`
- **Internal**
  - `POST /internal/v1/api-keys/exchange`: `exchangeApiKey` (internal)
  - `POST /internal/v1/service-tokens`: `createServiceToken` (internal)
  - `GET /.well-known/jwks.json`: `getJwks` (internal)
- `GET /healthz`, `GET /readyz`: shared probes
<!-- GENERATED:endpoints END -->

## Messages

<!-- GENERATED:messages START (source: asyncapi/events.yaml + bus/topology.yaml) -->
- **Publishes:** [`answer-capture.requested`](../events.md#catalog), [`content-extraction.requested`](../events.md#catalog), [`content-audit.requested`](../events.md#catalog), [`sitemap-discovery.requested`](../events.md#catalog), [`page-audit.requested`](../events.md#catalog), [`llms-txt-generation.requested`](../events.md#catalog)
- **Consumes:**
  - `rex.orchestrator.results` (prefetch 32): [`answer-capture.completed`](../events.md#catalog), [`answer-capture.failed`](../events.md#catalog), [`content-extraction.completed`](../events.md#catalog), [`content-extraction.failed`](../events.md#catalog), [`content-audit.completed`](../events.md#catalog), [`content-audit.failed`](../events.md#catalog), [`sitemap-discovery.completed`](../events.md#catalog), [`sitemap-discovery.failed`](../events.md#catalog), [`page-audit.completed`](../events.md#catalog), [`page-audit.failed`](../events.md#catalog), [`llms-txt-generation.completed`](../events.md#catalog), [`llms-txt-generation.failed`](../events.md#catalog)
<!-- GENERATED:messages END -->

## Dependencies

- Postgres (sole owner), object storage, RabbitMQ, Stripe (Phase 6).
- Never calls tool services or external services, so it has no cache; it sets the
  cache mode of jobs (`cacheMode` on create endpoints, `CacheDirective` in messages) and
  stores the cache outcomes reported in results. Billing meters LLM usage only for
  non-hit calls.
- Per-customer cache overrides (scope, TTLs) are org settings, validated against
  cache/policy.yaml when saved and copied into `CacheDirective.overrides` of every job
  the org publishes. Editing them is internal-only until roles exist
  ([deferred decisions](../roadmap.md#deferred-decisions)).
- **Job settings resolution** (the one definition): a setting a create endpoint
  accepts, such as the llms.txt crawl's `respectRobotsTxt` and `maxPages`, comes from
  the request, else the org setting of the same name, else its default; the resource
  stores the effective value. Limits from the plan (membership tiers, deferred) will
  cap the result: the smaller value wins. Org settings are internal-only to edit, like
  cache overrides.
- Packages: `@rex/bus` (pinned, [ADR 0019](../adr/0019-internal-packages.md)); public: `fastify`, `jose`, `pg`, a migration runner chosen in Phase 3; the data layer (transactions, RLS org context) lives inside the service.
- Vendored contracts: own spec, events, topology, cache policy (validates per-customer overrides).

## Notes

- Content extraction ([ADR 0021](../adr/0021-content-extraction.md)): when a tool
  needs a page, the `optimization` module has a worker call the content-extractor
  service (the service extracts), stores only the page reference the result reports
  (cache keys, never the page), then publishes the tool job with that reference
  ([page results by reference](../architecture.md#page-results-by-reference),
  [ADR 0023](../adr/0023-llms-txt-pipeline.md)). Each job has its own job-ledger row
  and idempotency key and the usual reconciler deadline.
  - **Audit:** `content-extraction` with `{url, include: [robotsTxt, llmsTxt]}`
    (`llmsTxt` only when the requested categories include `llms_txt`; key
    `audit:<auditId>:extract`), then `content-audit` (key `audit:<auditId>`) with
    `{page: <the reported PageRef>, options: <the audit options>}`. A failed
    extraction fails the audit, and so does a `content-audit` failure such as
    `page_result_missing`.
  - **llms.txt:** the event-driven pipeline of
    [ADR 0023](../adr/0023-llms-txt-pipeline.md), shown in
    [architecture](../architecture.md#llmstxt-pipeline). `stage` moves `discovering`,
    `auditing`, `generating`, `done`.
    (1) `sitemap-discovery` with `{siteUrl, respectRobotsTxt}` (effective value,
    default true; key `llms:<llmsTxtId>:discover`); its failure fails the resource.
    (2) Selection, in the module: the site root first, then the discovered URLs in
    order, same host only, deduplicated after URL normalization (as policy.yaml
    canonicalizes URLs), up to `maxPages` (no limit when unset); stored as pending page
    rows. With `respectRobotsTxt` the sitemap-extractor has already left disallowed
    URLs out. (3) One `page-audit` per page with `{extraction: {url,
    respectRobotsTxt}, entry: <page entry options>}` (key `llms:<llmsTxtId>:page:<n>`;
    a page robots.txt disallows fails as `robots_disallowed`); each result marks its
    row audited, with the two cache keys it reports, or failed (only status and keys
    are stored; contents stay in the cache and the data-aggregator). (4) When every
    row is terminal and at least one was audited, `llms-txt-generation` (key
    `llms:<llmsTxtId>:generate`) with the audited pages' `PageResultRef`s in order and
    the assembly options; if none was, the resource fails. `pagesMissing` from the
    result moves that many pages from `audited` to `failed`. The resource's `pages` counters show
    `{selected, audited, failed}`.
- URL-based structured-data check: a planned `structured-data-check` job that a worker
  runs against the external [seo-auditor](seo-auditor.md); its endpoint and resource
  come with the seo-auditor's interface ([deferred decisions](../roadmap.md#deferred-decisions)).
- A prompt run with *p* prompts, *e* engines and *s* samples publishes *p x e x s*
  `answer-capture` jobs (cache variant = sample index); entitlements are checked before
  publishing.
- Sentiment analyzers for a run come from `PromptRunOptions.sentiment` (default
  deterministic), including `language` and `onUnsupportedLanguage`; comparison views
  show each analyzer's results side by side.
- When a brand's aliases change, past answers are not re-analyzed automatically; a
  re-analysis job is a [deferred decision](../roadmap.md#deferred-decisions).
- Visibility-change alerts are computed by the run finalizer (move of at least 0.10
  absolute versus the previous run, configurable) and sent as `notification` jobs
  (Phase 6); they are not bus messages of their own.
