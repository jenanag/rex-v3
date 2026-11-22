# Conventions

Rules every service, package and contract follows. Where a rule has a machine-readable
source, this page links to it instead of restating it (see the [DRY rule](dry-rule.md)).

> **DRY RULE (summary).** Every contract, schema, config and rule has exactly one source
> of truth. Shared things are referenced (`$ref`, import, generate), never copied. Business
> logic and data are *not* shared across services: duplication beats wrong coupling.
> **Portability beats DRY across tool boundaries:** tools get generated copies of their
> contract and template boilerplate, with drift checked in CI.
> Full rule, exceptions and enforcement: [dry-rule.md](dry-rule.md) and [ADR 0007](adr/0007-dry-policy.md).

## 1. Naming

| Thing | Style | Example |
|---|---|---|
| Service name / folder / Docker image | kebab-case | `engine-query` |
| Internal package name (only those in ADR 0019) | `@rex/<kebab>` | `@rex/cache` |
| Postgres schema | orchestrator module name | `tracking` |
| Tables and columns | snake_case, plural tables | `prompt_runs.created_at` |
| URL path segments | kebab-case, plural nouns | `/v1/prompt-runs` |
| JSON fields, query params | camelCase | `promptRunId`, `?projectId=` |
| Path params | camelCase ID name | `{promptRunId}` |
| `operationId` | camelCase verb + noun, unique across all specs | `listPromptRuns` |
| Enum values | snake_case | `third_party` |
| Job type | kebab-case noun phrase | `answer-capture` |
| Message type | `<job>.<requested\|completed\|failed>` | `answer-capture.completed` |
| Routing key | message type + optional `.<shard>` | `answer-capture.requested.chatgpt` |
| Exchange | `rex.<name>` | `rex.events` |
| Queue | `rex.<consumer>.<job>[.<shard>]` | `rex.workers.answer-capture.chatgpt` |
| Env vars | SCREAMING_SNAKE_CASE (see §12) | `DATABASE_URL` |
| Error `code` | snake_case | `validation_failed` |
| Files | kebab-case | `prompt-run.repo.ts` |
| Idempotency key of a job | `<job-kind>:<subject ids...>` | `answer:run_...:prm_...:chatgpt:0` |

## 2. REST style

- Resources are plural nouns. Public `/v1/...` paths belong to the orchestrator, except
  `/v1/tools/...`, which the gateway maps to tool operations marked `x-rex-public`
  (route table generated from the specs).
- **Flat collections**: child resources are top-level collections filtered by parent,
  e.g. `GET /v1/prompts?projectId=prj_...` and `POST /v1/prompts {projectId}`, never
  `/v1/projects/{id}/prompts`.
- **Tool APIs** are functions over HTTP: `POST /v1/<noun>` takes the full input and
  returns the full output (200), with no resource IDs, no persistence, no 201/202, no
  pagination and no idempotency keys (calls are naturally repeatable). Every tool
  response that used an LLM includes `usage` (`LlmUsageList`).
- **Tools are cacheable functions.** Everything that changes a tool's output (model,
  engine, analyzers, options) is part of its request, so the caller's cache key covers
  it. Tools never cache, never mention the cache and never set cache headers; callers
  do ([§15](#15-caching)).
- **Deterministic first** ([ADR 0017](adr/0017-deterministic-first-analysis.md)): an
  operation that uses an LLM offers a deterministic method when one is feasible, and
  LLM methods take the model as input (`<provider>/<model>`) so runs can be compared.
- Leaf resources are addressed by ID: `/v1/prompts/{promptId}`. IDs are globally unique.
- Methods: `GET` read, `POST` create or action, `PATCH` partial update with JSON Merge
  Patch semantics (RFC 7396, sent as `application/json`), `DELETE` delete (204).
- Non-CRUD actions are `POST /v1/<resource>/{id}/<verb>`, e.g. `/cancel`, `/trigger`.
- Status codes: 200 read/update, 201 created (+ `Location`), 202 accepted async job
  (+ `Location`), 204 no body. Errors per §4.
- Single resources are returned bare (no envelope). Lists use the page envelope (§5).
- Request bodies reject unknown fields (`unevaluatedProperties: false`), responses may
  add fields at any time, and clients must ignore unknown fields and unknown enum values
  (**tolerant reader**). That is what makes additive changes non-breaking.
- Internal-only endpoints live under `/internal/v1/...`, carry `x-internal: true`, and
  are never routed by the gateway. Health probes are `/healthz` and `/readyz`
  (`$ref` [common.yaml](../packages/contracts/openapi/common.yaml) `pathItems`).
- Contracts are OpenAPI 3.1 / JSON Schema 2020-12. Use `oneOf` + `const` instead of
  `discriminator` in any schema a bus message payload also references (AsyncAPI treats
  `discriminator` differently).

### Sync vs async

- **Orchestrator** endpoints answer synchronously only for database work. Anything that
  needs a tool returns `202` with a job resource (`JobFields` in common.yaml: `status`,
  `error`, `createdAt`, `startedAt`, `completedAt`) and runs as a bus job.
- **Tool** endpoints are always synchronous. Each tool operation declares its
  operational limits once, in its `x-rex-limits` extension (fields below); slow ones
  are called only by workers, with `maxDuration` as the timeout. Descriptions may
  repeat a duration only if it equals the extension (checked).
- **Tools never touch the network** except an LLM provider's API: every tool operation
  declares `outboundFetch: none` (checked). Pages, site files and their extracted
  content come in the request: the orchestrator publishes `content-extraction` jobs,
  workers call the external content-extractor, and the orchestrator passes the results
  on in the tool jobs ([ADR 0021](adr/0021-content-extraction.md)). Only external
  services read websites; no REx service does.
- **External services** (content-extractor, sitemap-extractor, seo-auditor,
  data-aggregator; kind `external` in [architecture](architecture.md#service-map)) are
  called only by workers, on orchestrator-issued jobs, cache first where their results
  are cacheable. **No service touches the bus:** only the orchestrator publishes jobs
  and only workers publish results (`x-rex-producers`, checked).
  Services fetch and extract; workers only call them. Page bodies never go on the bus:
  page flows pass [page results by reference](architecture.md#page-results-by-reference).
  REx writes an external service's contract only once its interface is decided; until
  then its doc lists what is unknown and nothing about it is guessed.
- An `x-rex-public` tool operation takes content (HTML, JSON-LD, a robots.txt or
  llms.txt file), makes **no LLM call** and has p99 under 2 s. A URL-based public flow
  goes through the orchestrator's async, anonymous endpoints (`createAudit`,
  `createLlmsTxt`), never through a tool.
- `x-rex-limits` fields: `llm` (`none`, `optional`: only when the request asks for it,
  `required`), `outboundFetch` (`none`, `one`, `several`, `crawl`), and where they apply
  `maxDuration`, `llmCallTimeout`, `p99` (ISO 8601 durations), `fetchTimeout`,
  `fetchMaxBytes` (bytes) and `notes`. The per-tool `AGENTS.md` and service docs render
  them; they are never restated by hand.

## 3. Versioning

- The major version is in the path: `/v1`. Additive changes (new endpoint, optional
  request field, new response field, new enum value) stay in `v1`.
- Breaking changes ship a new path version for the affected resources (`/v2/...`) while
  `v1` keeps working. The old version answers with `Deprecation` (RFC 9745) and `Sunset`
  (RFC 8594) headers and is removed no earlier than 6 months later.
- `info.version` of each spec follows semver for the contract document itself.
- Until a contract's first implementation exists (no consumer to protect), a breaking
  change bumps only the `info.version` major and keeps `/v1` (example: content-extractor
  2.0.0, events.yaml 3.0.0, [ADR 0023](adr/0023-llms-txt-pipeline.md)); the cache
  key's `specMajor` follows it.
- Message versioning: [events.md](events.md#versioning).

## 4. Errors

All errors are RFC 9457 problem details, `Content-Type: application/problem+json`, using
the shared `Problem` schema and the shared responses in
[common.yaml](../packages/contracts/openapi/common.yaml) (`BadRequest`, `Unauthorized`,
`Forbidden`, `NotFound`, `Conflict`, `UnprocessableContent`, `TooManyRequests`,
`InternalError`, `ServiceUnavailable`). Service specs `$ref` them; they never define
their own error schema.

- `type` is `{PROBLEM_BASE_URI}/{code}`, `code` is a stable snake_case identifier, and
  `traceId` is always set. `PROBLEM_BASE_URI` is a deployment setting; the product
  domain is [deferred](roadmap.md#deferred-decisions), so environments use the
  placeholder `https://problems.rex.invalid` until it is chosen.
- 400 is schema validation (`code: validation_failed`, with `errors[].pointer`), 409 is a
  state conflict, 422 is a business-rule violation, 404 is also used for resources in
  another org (never 403, to avoid leaking existence).
- Each service maps thrown domain errors to problems in one place (tools: `src/errors.ts`
  from the template); handlers never hand-build error bodies.

## 5. Pagination

Cursor pagination only. Query `cursor` and `limit` (1 to 100, default 20), both shared
parameters. Response:

```json
{ "data": [ ... ], "page": { "nextCursor": "eyJ...", "hasMore": true } }
```

Cursors are opaque (base64url of the sort key plus ID), stable under inserts, and do not
expire. Default sort is newest first by `(createdAt, id)` unless the endpoint says otherwise.
Specs compose the shared `Page` schema with `allOf` and only declare `data.items`.
Bounded aggregate endpoints (for example visibility summaries) are not paginated and
say so in their description.

## 6. IDs

Prefixed ULIDs: `<prefix>_<26-char Crockford base32 ULID>`, e.g.
`prj_01JD3Z8XQK5V7N2M4P6R8T0W2Y`. Time-sortable, globally unique, self-describing in logs.
The **prefix registry is the `*Id` schemas in
[common.yaml](../packages/contracts/openapi/common.yaml)**; add a new prefix there (2 to 4
lowercase letters, unique). IDs are generated by the owning service, never by clients,
and stored as `text` with a `CHECK` on the pattern.

## 7. Timestamps and time

- RFC 3339 in UTC with `Z` and millisecond precision (`Timestamp` schema). Stored as
  `timestamptz`. Fields end in `At` (`createdAt`, `capturedAt`).
- Ranges use `from` (inclusive) and `to` (exclusive), max 366 days.
- Time zones appear only where a human schedule needs one (`Schedule.timezone`, IANA).
- Every mutable resource has `createdAt` and `updatedAt` (`ResourceTimestamps`).

## 8. Idempotency

- Every `POST` that creates a resource or starts a job accepts `Idempotency-Key`
  (shared parameter). Keys are scoped per org + route and kept 24 hours.
- Same key and same body: the stored response is replayed. Same key with a different
  body: 422 `idempotency_key_reused`. Same key while the first request is in flight: 409
  `idempotency_key_in_flight`.
- Implemented once in the orchestrator, backed by its `messaging` schema. Tools do not
  take `Idempotency-Key`.
- Bus consumers are idempotent: the orchestrator dedupes by message `id` (inbox) and by
  job `idempotencyKey` (job ledger); see [events.md#delivery](events.md#delivery).

## 9. Auth headers

| Caller | Header | Verified by |
|---|---|---|
| Dashboard user | `Authorization: Bearer <access token>` | gateway, then the orchestrator |
| API client | `X-API-Key: rex_live_...` | gateway (exchanged for an access token) |
| Gateway to orchestrator | `Authorization: Bearer <access token>` (internal endpoints: service token) | orchestrator (`jose`) |
| Gateway or worker to tool | none | not verified by the tool: NetworkPolicy admits only workers and the gateway |

**Tools have no auth**: tool specs declare `security: []`, tools ignore `Authorization`,
and they carry no auth dependency or key configuration. All tokens are one JWT format
issued by the orchestrator's identity module and verified by the gateway and the
orchestrator with `jose`. Token types, claims, lifetimes and how tool access is enforced:
[ADR 0014](adr/0014-auth.md).
Inbound `X-Rex-*` headers are stripped by the gateway.

Other standard headers: `X-Request-Id` (generated by the gateway if absent, echoed on
every response), `traceparent`/`tracestate` (W3C Trace Context), `Idempotency-Key`,
`Retry-After` on 429 and 503. Public tool calls through the gateway also return
`X-Rex-Cache` and, on hits, `X-Rex-Cached-At` (common.yaml `headers`), and honor
`Cache-Control: no-cache` as a refresh.

## 10. Tenancy in code

Tenancy exists only in the orchestrator. Every tenant-owned row has `org_id` (and
`project_id` where it belongs to a project). Repos take the org from the verified token
(or, for job results, from the job ledger), never from the request or message body.
Postgres row-level security on `org_id` is enabled on every tenant table as a second
guard (the orchestrator's data layer sets `app.org_id` per transaction). Tools are
tenant-agnostic and receive no tenant IDs.

## 11. Logging, tracing and metrics

Structured JSON logs (pino, Fastify's logger) and OpenTelemetry traces and metrics
(`@opentelemetry/sdk-node`) exported over OTLP, set up per service (tools: template;
Python and Go tools use the equivalents in [ADR 0024](adr/0024-per-tool-language.md)
with the same fields). Standard log fields, set automatically where known:

`time`, `level`, `msg`, `service`, `version`, `env`, `requestId`, `traceId`, `spanId`,
`orgId`, `projectId`, `actorId`, `actorType`, `method`, `route`, `statusCode`,
`durationMs`, `messageId`, `messageType`, `idempotencyKey`, `queue`, `attempt`,
`tool`, `operationId`, `cacheOutcome`, `engine`, `analyzer`, `err`. Cache keys are
logged only at `debug`. Metrics include cache hits, misses and uncacheable results per
tool operation.

Never log secrets, tokens, API keys, passwords or full request bodies. Answer text is
logged only at `debug`.

## 12. Environment variables

- SCREAMING_SNAKE_CASE. Shared infra vars have no prefix and mean the same thing in every
  service that uses them: `NODE_ENV`, `SERVICE_NAME`, `PORT`, `LOG_LEVEL`,
  `OTEL_EXPORTER_OTLP_ENDPOINT`, `PROBLEM_BASE_URI`. `DATABASE_URL` exists only in the
  orchestrator, `RABBITMQ_URL` only in the orchestrator and workers,
  `CACHE_REDIS_URL` only in workers and the gateway,
  `EDGE_REDIS_URL` only in the gateway, and so do `REX_JWKS_URL` and
  `SERVICE_CLIENT_SECRET`. `CONTENT_EXTRACTOR_URL`, `SITEMAP_EXTRACTOR_URL`,
  `DATA_AGGREGATOR_URL` and `SEO_AUDITOR_URL` (base URLs of the external services)
  exist only in workers. Tools
  have none of them.
- Tools add `LLM_MODE` (`live`, `mock`, `record`; default `mock` when `NODE_ENV=test`)
  when they call LLMs, plus the provider keys they use (only needed for `live` and
  `record`).
- Configurable policies keep their values in contract files and accept per-environment
  overlays of the same shape: `BUS_RETRY_OVERRIDES` (retry policy, topology.yaml) and
  `CACHE_POLICY_OVERRIDES` (cache scope and TTLs, policy.yaml).
- Provider credentials use the vendor's conventional name: `OPENAI_API_KEY`,
  `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `PERPLEXITY_API_KEY`, `XAI_API_KEY`.
- Service-specific vars start with the service or role name: `ORCHESTRATOR_ROLES`,
  `WORKER_QUEUES`, `ENGINE_QUERY_TIMEOUT_MS`.
- Each service declares its env schema once with `env-schema` (tools: `src/config.ts`,
  template base plus the tool's own vars); `.env.example` and the env table in each
  README are generated from it. Missing or invalid env fails startup.

## 13. Code layout

Every service follows the layout for its kind in [architecture.md](architecture.md#per-service-layouts).
Tools are created by `scripts/new-tool --lang <ts|python|go>` from the template of
their language (`services/_template` in Phase 1; `_template-python` and `_template-go`
when the first tool in that language is scheduled, [ADR 0024](adr/0024-per-tool-language.md)).

## 14. DRY RULE

**One source of truth for everything; reference, never copy. Except business logic
across service boundaries.** This is a hard rule, enforced in CI. Read
[dry-rule.md](dry-rule.md) before adding any schema, helper, config or doc section.

## 15. Caching

- **Cache first, always:** no code calls a tool except through `@rex/cache`, which
  checks the cache before the call ([ADR 0016](adr/0016-cache-first.md)). Only workers
  and the gateway import it.
- Keys, modes, store rules and TTLs come only from
  [cache/policy.yaml](../packages/contracts/cache/policy.yaml); never build a cache key
  by hand or hard-code a TTL.
- A tool change that alters the output for the same input bumps the tool's `keyVersion`
  in policy.yaml in the same PR.
- New tool operations get a policy entry in the same PR as their spec (CI fails
  otherwise); side-effecting operations are listed with `cacheable: false`.
- Jobs pass the caller's choice as `cache` (`CacheDirective`), including the org's
  per-customer overrides; results report one `ToolCallCache` per call.
- Scope (`shared` or `tenant`), TTLs and windows are configuration: change them through
  the layers in policy.yaml `resolution`, never in code.
- Language-dependent tool behavior takes a `LanguageTag` input, publishes the languages
  it supports, and lets the caller choose between fallback and a 422 for unsupported
  languages (pattern: answer-analysis).

## 16. Tool portability

Tool development comes first, and every tool is a self-contained project in its
language ([ADR 0018](adr/0018-tool-portability.md),
[ADR 0024](adr/0024-per-tool-language.md)). The language is `language` in
[vendoring.yaml](../packages/contracts/vendoring.yaml) (`ts`, `python` or `go`; set by
the tool's own language ADR, accepted by Jay; `ts` until then); the rules below hold in every language.

- **The folder test:** copy `services/<tool>/` anywhere; install, build, test and
  `docker build .` must pass with no other file of the repo present (`npm ci`,
  `npm run build`, `npm test`; `uv sync --frozen`, `uv run pytest`; `go build ./...`,
  `go test ./...`). CI runs exactly that for every changed tool.
- **Dependencies:** public packages from the language's public registry only (npm,
  PyPI, public Go modules), exact versions, committed lockfile (`package-lock.json`,
  `uv.lock`, `go.sum`). No `workspace:`, `file:`, `link:` or `portal:` specifiers, no
  path, git or editable sources in `pyproject.toml`, no `replace` directives in
  `go.mod`, no `@rex/*` or other internal packages
  ([ADR 0019](adr/0019-internal-packages.md)). Runtime packages come only from the
  [approved tool dependencies](#approved-tool-dependencies) of the tool's language.
- **No imports outside the folder.** Not even type-only imports or test helpers.
- **Contract:** `contract/` is generated by `scripts/vendor-contracts`; never edit it.
  Change the source in `packages/contracts`, re-vendor, commit both.
- **Boilerplate:** template files listed in `.template.json` are not edited in place;
  improve the template and run `scripts/new-tool --upgrade <tool>`, or mark the file
  `owned: true` when the tool genuinely needs to diverge.
- **LLM calls** go through the tool's LLM adapter only (`src/llm/` in TypeScript; the
  other layouts in [architecture](architecture.md#per-service-layouts)), which wraps the
  official SDKs. Tests run
  with `LLM_MODE=mock` (recorded fixtures in `test/fixtures/llm/`, no keys, no
  network); refresh fixtures with `LLM_MODE=record` and real keys on a developer
  machine, never in CI.
- **No outbound fetches:** tools have no HTTP client besides the LLM SDKs; fetching
  rules (size and time bounds, SSRF guard) belong to the content-extractor contract
  ([ADR 0021](adr/0021-content-extraction.md)).
- **Tools have no auth**, no cache and no bus (see [§9](#9-auth-headers), [§15](#15-caching)).
- **Tools never retry.** Not an LLM call (the adapter sets the SDKs' own retries to
  0), not a whole operation. A failed upstream call becomes an error
  response (`503` with `Retry-After` when the upstream said so); callers own retries
  (workers through the bus retry policy, the gateway not at all).
- **Request validation budget:** TypeScript 1 ms p99 at every valid body size up to
  the tool's body limit ([ADR 0026](adr/0026-typescript-validation-budget.md), Proposed);
  Python 5 ms and Go 1 ms ([ADR 0024](adr/0024-per-tool-language.md)).

### Approved tool dependencies

The single list of runtime packages tools may use, one table per language; a tool uses
the table of its `language`. `all` means the language's template installs it in every
tool; `--llm` means the template switch of `scripts/new-tool` (built in Phase 1); a tool
name means that tool; several scopes are comma-separated. Service docs render each
tool's packages from its language's table.

#### TypeScript (`ts`)

| Package | Purpose | Tools |
|---|---|---|
| `fastify` | HTTP server | all |
| `@fastify/sensible` | HTTP errors and helpers | all |
| `@fastify/under-pressure` | load shedding, readiness | all |
| `ajv` | JSON Schema 2020-12 validation | all |
| `ajv-formats` | formats for Ajv | all |
| `env-schema` | config from env | all |
| `pino` | logs (Fastify's logger) | all |
| `@opentelemetry/sdk-node` | traces and metrics | all |
| `@opentelemetry/auto-instrumentations-node` | HTTP instrumentation (including Node's built-in fetch used by the LLM SDKs) | all |
| `openai` | LLM SDK (also Perplexity and xAI via `baseURL`) | --llm |
| `@anthropic-ai/sdk` | LLM SDK | --llm |
| `@google/genai` | LLM SDK | --llm |
| `cheerio` | HTML parsing of the raw page passed in | content-auditor, schema-generator |
| `robots-parser` | robots.txt rules | content-auditor |
| `jsonld` | JSON-LD expansion for validation | schema-generator |
| `marked` | Markdown lexer for inline links in answer text | citation-extractor |

#### Python (`python`)

Approved by Jay with [ADR 0024](adr/0024-per-tool-language.md) on 2026-11-22. The
Python spike is still a gate: no tool uses these until it passes, right before the
first Python tool's step.

| Package | Purpose | Tools |
|---|---|---|
| `fastapi` | HTTP server | all |
| `uvicorn` | ASGI server | all |
| `openapi-core` | request and response validation from `contract/openapi.yaml` (gated by the Python spike) | all |
| `pydantic` | models generated from the contract (types, not the validator) | all |
| `pydantic-settings` | config from env | all |
| `structlog` | JSON logs | all |
| `opentelemetry-sdk` | traces and metrics | all |
| `opentelemetry-exporter-otlp` | OTLP export | all |
| `opentelemetry-instrumentation-fastapi` | HTTP server instrumentation | all |
| `opentelemetry-instrumentation-httpx` | instrumentation of the HTTP client the LLM SDKs use | --llm |
| `openai` | LLM SDK (also Perplexity and xAI via `base_url`) | --llm |
| `anthropic` | LLM SDK | --llm |
| `google-genai` | LLM SDK | --llm |

#### Go (`go`)

Approved by Jay with [ADR 0024](adr/0024-per-tool-language.md) on 2026-11-22. The Go
spike is still a gate: no tool uses these until it passes, right before the first Go
tool's step (ai-traffic-analyzer, Phase 7). The standard
library covers the HTTP server (`net/http`) and logs (`log/slog`).

| Package | Purpose | Tools |
|---|---|---|
| `github.com/getkin/kin-openapi` | request and response validation from `contract/openapi.yaml` (gated by the Go spike) | all |
| `github.com/oapi-codegen/runtime` | runtime helpers for the generated types | all |
| `github.com/caarlos0/env` | config from env | all |
| `go.opentelemetry.io/otel` | traces and metrics (with its `sdk` and OTLP exporter modules) | all |
| `go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp` | HTTP server and client instrumentation | all |
| `github.com/openai/openai-go` | LLM SDK (also Perplexity and xAI via a base URL option) | --llm |
| `github.com/anthropics/anthropic-sdk-go` | LLM SDK | --llm |
| `google.golang.org/genai` | LLM SDK | --llm |

Template switches per tool: `--llm` for engine-query, answer-analysis and
llms-txt-generator. There is no fetch switch: no tool fetches (ADR 0021). Dev
dependencies are set by each language's template and pinned like everything else
(TypeScript, vitest, ESLint, Prettier; pytest, ruff, mypy; golangci-lint).

**Adding a dependency needs Jay's approval.** Propose it in the change description:
package, exact version, purpose, which tools, license, maintenance (last release,
weekly downloads) and why no listed package or a few lines of code will do. Once
approved, add the row to the table of the tool's language in the same change; CI rejects a
tool manifest (`package.json`, `pyproject.toml`, `go.mod`) with a runtime package not
listed for that tool. Version bumps of listed packages need no
approval (Renovate, exact versions).

