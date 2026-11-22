# The DRY rule

**Every piece of knowledge has exactly one authoritative source. Everything else
references it (`$ref`, import, link) or is generated from it.** Decision record:
[ADR 0007](adr/0007-dry-policy.md). Across tool boundaries, generated copies replace
references so each tool stays self-contained ([§3](#3-portability-beats-dry-across-tool-boundaries),
[ADR 0018](adr/0018-tool-portability.md)).

DRY is about knowledge, not about lines that happen to look alike. Two tools that both
have a `url` field are not a violation. Two files that both define what an error
response or a queue binding looks like are.

## 1. Where each thing lives

| Knowledge | Single source | Consumers get it by |
|---|---|---|
| Shared HTTP contract parts: `Problem`, error responses, `Page`/`PageInfo`, cursor/limit/time-range params, `Idempotency-Key`, security schemes, ID schemas (prefix registry), `Timestamp`, `EngineId`, `JobFields`, `TrackedBrand`, `AnswerSource`, `LlmUsage`, `LlmsTxtValidation`, page inputs (`ExtractedContent`, `FetchedPage`, `FetchedFile`), `LanguageTag`, `IsoDuration`, cache shapes (`CacheMode`, `CacheScope`, `CacheOverride`, `CacheDirective`, `ToolCallCache`, `X-Rex-Cache` headers), health probes | [`packages/contracts/openapi/common.yaml`](../packages/contracts/openapi/common.yaml) | `$ref` |
| A service's REST contract (input, output, operations) | `packages/contracts/openapi/services/<service>.yaml` | `$ref` from the orchestrator spec and from bus messages; **vendored** (bundled, self-contained) into each service that serves or calls it, as listed in [`vendoring.yaml`](../packages/contracts/vendoring.yaml); a service built outside this repo (content-extractor) gets a generated hand-off copy in `packages/contracts/handoff/` |
| What is vendored where | [`packages/contracts/vendoring.yaml`](../packages/contracts/vendoring.yaml) | read by `scripts/vendor-contracts` (writes) and `scripts/check-contracts` (drift) |
| Bus messages: routing keys, versions, producers, payloads | [`packages/contracts/asyncapi/events.yaml`](../packages/contracts/asyncapi/events.yaml) | vendored into the orchestrator and workers; types and validators generated there; [events.md](events.md) is its generated catalog |
| Exchanges, queues, bindings, retry delay queues and retry policy, dead-lettering, prefetch, and therefore **who consumes what** | [`packages/contracts/bus/topology.yaml`](../packages/contracts/bus/topology.yaml) | vendored; declared by `@rex/bus`; AsyncAPI channel bindings `$ref` its exchange objects |
| Cache key derivation, cache modes, scopes, store rules, TTL or window and scope per tool operation, override resolution (customer, environment, default) and limits, cache backend | [`packages/contracts/cache/policy.yaml`](../packages/contracts/cache/policy.yaml) | vendored into workers, gateway and orchestrator; applied by `@rex/cache`; docs link to it |
| Retry policy values (delays, counts, per-queue overrides) | `retry` in topology.yaml (placeholders, policy deferred) | `@rex/bus`; per-environment overlay `BUS_RETRY_OVERRIDES` |
| Reading websites: page fetches, redirects, SSRF guard, robots.txt, llms.txt, main-content extraction | the external content-extractor, to its contract [`content-extractor.yaml`](../packages/contracts/openapi/services/content-extractor.yaml) ([ADR 0021](adr/0021-content-extraction.md)), called only by workers; the fetching rules there apply to every external service | tools receive `ExtractedContent`, `FetchedPage`, `FetchedFile`, `PageMetadata` in requests; no tool or worker fetches; `respectRobotsTxt` there only refuses a disallowed URL |
| URL discovery: sitemaps, robots.txt rules for a crawl, the site-root link fallback | the external sitemap-extractor, to its contract [`sitemap-extractor.yaml`](../packages/contracts/openapi/services/sitemap-extractor.yaml) ([ADR 0023](adr/0023-llms-txt-pipeline.md)), called only by workers | the content-extractor no longer lists links or sitemaps (2.0.0); orchestrator and workers only pass the URL list on |
| Page results by reference: page refs, read order (cache, then data-aggregator) | [architecture: page results by reference](architecture.md#page-results-by-reference), `PageRef` in events.yaml, `byReference` in policy.yaml ([ADR 0023](adr/0023-llms-txt-pipeline.md)) | both page flows (audits, llms.txt); workers doc and orchestrator doc link to it |
| Page archive: what is archived and when | `archiveTo` and the store rules in policy.yaml ([ADR 0022](adr/0022-page-archive.md)) | the workers' `extractContent` and `describePage` calls; the data-aggregator doc links to it |
| Job settings resolution (request, org setting, default; tier limits later) | [orchestrator](services/orchestrator.md#dependencies) | create endpoints and resource descriptions link to it |
| Sentiment analyzers available | answer-analysis `listAnalyzers` | callers read it; never hard-coded elsewhere |
| Engine list for per-engine queues | `EngineId` in common.yaml | `{engine}` expansion in topology.yaml |
| AI crawler list | [`packages/contracts/data/ai-crawlers.yaml`](../packages/contracts/data/ai-crawlers.yaml) | vendored into content-auditor (and ai-traffic-analyzer in Phase 7) |
| Gateway route table | orchestrator spec + `x-rex-public` operations of tool specs | generated by `scripts/gen-gateway-routes` from the gateway's vendored copies |
| API types and clients | the vendored specs | generated per consumer, committed, never hand-written: platform clients with `openapi-typescript` and `openapi-fetch`; a tool's own types with the generator of its language (`languages` in vendoring.yaml) |
| A tool's language, and the template and type generator of each language | `language` and `languages` in [`vendoring.yaml`](../packages/contracts/vendoring.yaml) ([ADR 0024](adr/0024-per-tool-language.md)) | read by `scripts/vendor-contracts`, `scripts/new-tool`, `scripts/gen-docs` and the CI matrix; service docs and tool `AGENTS.md` render it |
| Request validation | the vendored spec | the validator chosen by each language's spike (TypeScript: Ajv 2020, [ADR 0020](adr/0020-fastify-openapi-validation.md)); no hand-written route schemas or code-first models as the validator |
| Tool boilerplate: server bootstrap, problem+json mapping, health probes, config, telemetry, LLM adapter, Dockerfile, CI job | the template of the tool's language (`services/_template`; `_template-python`, `_template-go` once added) | generated into each tool by `scripts/new-tool`; tracked in the tool's `.template.json`; drift checked in CI |
| Cache-first tool calls: key derivation, read/store, single-flight, outcome reporting | `@rex/cache` (`packages/cache`) | pinned dependency (workers and gateway only) |
| AMQP connection, topology declaration, publish with confirms, consume with manual ack, configurable retries, envelope | `@rex/bus` (`packages/bus`) | pinned dependency (orchestrator and workers only) |
| Which internal packages exist and why | [ADR 0019](adr/0019-internal-packages.md) | link; a new package needs a new ADR |
| Platform tsconfig, ESLint, Prettier, Vitest settings | root config files | `extends` from platform services; tools carry template copies |
| Dependency versions | each `package.json` (exact versions) | `syncpack` aligns platform versions; Renovate groups upgrades |
| CI pipeline steps | reusable workflows in `.github/workflows/` | `uses:` |
| Metric definitions (share of voice, mention rate, ...) | [glossary.md](glossary.md) | link |
| Conventions | [conventions.md](conventions.md) | link |
| Phase plan | [roadmap.md](roadmap.md) | link |

## 2. Rules

1. **Reference, never copy, inside the contracts.** If a schema, parameter, response,
   header, security scheme, exchange or queue already exists in a contract file, `$ref`
   it.
2. **Promote at the second contract consumer.** A contract shape used by two or more
   specs moves to common.yaml (or stays in its owner's spec and is `$ref`'d there).
   Contracts are cheap to share because they are data, not behavior.
3. **Tool output is embedded, not remodelled.** Orchestrator resources and bus results
   `$ref` the tool's output schema (`EngineAnswer`, `MentionDetail`, `CitationDetail`,
   `AuditResult`, `LlmsTxtResult`) and add only their own IDs and metadata.
4. **Shared code is the exception.** Prefer a well-known public package, then generated
   code, then per-service code. An internal package exists only when two services must
   run identical behavior ([ADR 0019](adr/0019-internal-packages.md)); it is technical,
   published and pinned, and never used by a tool.
5. **Generate, don't hand-write.** Vendored contracts, types per language and clients, bus message
   types and validators, gateway routes, `.env.example`, tool boilerplate, the message
   catalog and the generated sections of service docs. Generated files carry a
   `GENERATED - DO NOT EDIT` header (vendored copies name their source).
6. **Docs link, they don't restate.** Service docs list operation and message *names*
   and link to the contract. Field lists live only in the contracts.
7. **One tool per job.** One OpenAPI linter and bundler (Redocly CLI), one AsyncAPI
   validator, one AMQP client (amqplib), one duplication checker (jscpd, all
   languages); per tool language one test runner, linter and formatter (Vitest, ESLint,
   Prettier; pytest, ruff, mypy; `go test`, golangci-lint), one request validator and
   one LLM SDK per provider ([ADR 0024](adr/0024-per-tool-language.md)).

## 3. Portability beats DRY across tool boundaries

Tools are the top priority and must build, test and run from their own folder
([ADR 0018](adr/0018-tool-portability.md)). Where that conflicts with DRY, portability
wins, under these rules:

- **Knowledge keeps one source; copies are generated.** A contract is edited only in
  `packages/contracts`. The copy in `services/<tool>/contract/` is generated by
  `scripts/vendor-contracts` and CI fails when it differs from a fresh generation.
  Hand edits to vendored files are never allowed.
- **Allowed duplication: thin, template-generated boilerplate.** Server bootstrap,
  error mapping, health probes, config schema base, telemetry setup, the LLM adapter,
  Dockerfile, language config (tsconfig and ESLint, `pyproject.toml` tool settings,
  `.golangci.yml`), `AGENTS.md` and the CI job are copied into each tool from the
  template of its language. Each copy is recorded in `.template.json`
  (template version, file hash); CI reports drift from the template, and
  `scripts/new-tool --upgrade` re-applies it. A tool that must diverge marks the file
  `owned: true`, and from then on the file is that tool's own code.
- **Not allowed: copying domain logic or contract shapes by hand** between tools, or
  from a tool into the platform. If two tools need the same non-boilerplate code,
  first look for a public package; if none fits, add it to the template (still
  generated, still drift-checked), never a shared internal package.
- **One rule, one template per language.** The tool rules (validation from the spec,
  problem+json, probes, `LLM_MODE`, no network, no auth, no retries) are written once
  ([conventions §16](conventions.md#16-tool-portability), [ADR 0024](adr/0024-per-tool-language.md));
  each language's template implements them once. The same boilerplate in two languages
  is not a clone to remove; a rule restated per template is.
- **Drift detection replaces shared code.** Contract drift, template drift and jscpd
  (outside template-generated files) together catch what a shared package would have
  prevented.

## 4. Enforcement

Phase 1 wires all of these into CI (on every PR; platform checks run for affected workspace packages, tool checks for each changed tool folder):

| Check | Tool | Fails when |
|---|---|---|
| OpenAPI validity and style | Redocly CLI with [redocly.yaml](../redocly.yaml) | any error (unresolved `$ref`, missing operationId, non-problem 4xx, non-kebab paths, ...) |
| AsyncAPI validity (incl. AMQP bindings resolved from topology.yaml) | AsyncAPI CLI `validate` | any error |
| No copied contract parts | `scripts/check-contracts` | a spec defines a component whose name exists in common.yaml; any `application/problem+json` schema other than a `$ref` to `Problem`; a list response without `Page`; any inline security scheme |
| No duplicated schemas | `scripts/check-contracts` | two schema subtrees across all contracts are structurally identical after normalization and have 3 or more properties |
| Stateless tools | `scripts/check-contracts` | a tool spec has a path parameter, a 201/202/204 response, `Idempotency-Key`, `Page`, `JobFields`, a tenant ID schema, or an `x-rex-public` operation that returns `usage` |
| No auth in tools | `scripts/check-contracts` | a tool spec's `security` is not `[]`, an operation declares `security`, a tool spec defines `securitySchemes`, has a 401/403 response, or mentions tokens or `Authorization`; a tool doc mentions tool auth |
| Tools never reference the cache | `scripts/check-contracts` | a tool spec mentions caching or references a cache schema or header |
| Cache policy complete and single | `scripts/check-contracts` | a tool operation has no entry in policy.yaml (or an entry names a missing operation); an entry has neither `ttl` nor `window` nor `cacheable: false`; a pointer names a field the request does not have; the key derivation steps or the override precedence are restated anywhere other than policy.yaml; a scope is not `shared` or `tenant`; `resolution` or `limits` missing, or a default outside `limits`; `CacheScope` differs from policy `scopes` |
| Languages designed in once | `scripts/check-contracts` | a language field in a tool or orchestrator spec does not `$ref` common.yaml `LanguageTag`; answer-analysis lacks `onUnsupportedLanguage` or the 422 `unsupported_language` code; the lexicon extension path is missing from the answer-analysis doc |
| Retry values configurable | `scripts/check-contracts` | a retry delay outside `retry.delayPool`, or concrete retry delays written in docs |
| Unique ownership | `scripts/check-contracts` | an operationId or tool path appears twice; an orchestrator path is under `/v1/tools` |
| Bus contract consistency | `scripts/check-contracts` | a routing key in events.yaml has no queue binding in topology.yaml (or a binding matches nothing); a producer other than orchestrator/workers; a requested message without completed and failed siblings |
| Vendored contracts in sync | `scripts/check-contracts` (runs `scripts/vendor-contracts --check`) | a `vendoring.yaml` entry has no copy, a copy differs from a fresh bundle of its source, a vendored OpenAPI file has an external `$ref`, a target is outside `contract/`, or a tool lacks its own bundled spec or its types entry |
| Tool languages consistent | `scripts/check-contracts` | a tool has no `language`, or one that is not a key of `languages` (`ts`, `python`, `go`); a language's template is not `services/_template` (ts) or `services/_template-<language>`; a language has no generator, no table in [conventions §16](conventions.md#approved-tool-dependencies), no layout in [architecture](architecture.md#per-service-layouts) or no column in [ADR 0024](adr/0024-per-tool-language.md); a platform service has a `language`; the ADR 0024 language table does not list every tool |
| Template drift | `scripts/new-tool --check` | a template-generated file differs from the version of its language's template recorded in `.template.json` and is not marked `owned` |
| Tools are self-contained | `scripts/check-contracts` + portability CI job | a tool `package.json` has a `workspace:`/`file:`/`link:`/`portal:` specifier or an `@rex/*` dependency, a `pyproject.toml` has a non-`==` pin or a path, git or editable source, a `go.mod` has a `replace` directive; the lockfile of its language is missing (`package-lock.json`, `uv.lock`, `go.sum`); any file in a tool folder references a path outside it; the tool copied to a temp dir outside the repo fails its language's install, build, tests (`LLM_MODE=mock`, no network) or `docker build`, or its container does not answer `/healthz` |
| Internal packages justified | `scripts/check-contracts` | `packages/` contains anything other than the packages listed in [ADR 0019](adr/0019-internal-packages.md); a service depends on an internal package with a non-exact version or a `workspace:` link |
| Generated docs in sync | `scripts/gen-docs --check` | the generated sections of events.md or docs/services/*.md, or a tool's `AGENTS.md`, differ from a fresh render |
| Agent instructions consistent | `scripts/check-contracts` | a tool has no `AGENTS.md`; a link in an `AGENTS.md` does not resolve; `AGENTS.md` lacks a hard rule or its superseded-ADR list or current phase disagrees with the docs; a command listed as working today does not exist, or a planned command already exists or is not a Phase 1 deliverable; the `AGENTS.md` status differs from the roadmap's Phase 0 status, the status range differs from the Accepted Phase 0 ADRs, or a later (Proposed) ADR is not named in it; a `npx` tool in a command is not pinned or pinned to different versions; a script is named that neither exists nor is planned in the roadmap; a pointer file (`CLAUDE.md`, `.cursor/rules/rex.mdc`, `.github/copilot-instructions.md`) does not point to `AGENTS.md`, is longer than 12 lines, or repeats its content |
| Operational limits declared once | `scripts/check-contracts` | a tool operation has no valid `x-rex-limits`; a public operation's limits break [conventions §2](conventions.md#sync-vs-async); a description states a duration that differs from the extension; a tool's LLM use disagrees with its template switch |
| Approved dependencies | `scripts/check-contracts` | a tool manifest (`package.json`, `pyproject.toml`, `go.mod`) has a runtime package not approved for that tool in the table of its language in [conventions §16](conventions.md#approved-tool-dependencies); a tool doc names a package not approved for it; the package table is restated elsewhere |
| External-service callers | `scripts/check-contracts` | anything but workers is shown or described as calling an external service (content-extractor, data-aggregator, seo-auditor: architecture kinds, communication rows, service-map edges, service docs, tool specs, tool `AGENTS.md`); their `*_URL` variables outside workers; an external service without a doc, or a doc of one with no contract that does not list what is unknown; `content-extraction.*` not published by the orchestrator and answered by workers; policy.yaml `external.content-extractor.callers` other than `[workers]`; any tool operation with `outboundFetch` other than `none`; a fetch switch or fetch-only package returns; the content-extractor spec lacks limits, health probes, problem+json errors or its hand-off copy |
| Generated code untouched | codegen per service, then `git diff --exit-code` | generated types, clients or routes differ from what is committed |
| Copy-paste code | jscpd | inside one service or package: duplication above **3 %**, or any clone of **50+ tokens / 10+ lines** in non-test code. Across tools: any clone of 50+ tokens outside template-generated files (each tool's `.template.json` list) is reported and fails when it is domain code. One run covers TypeScript, Python and Go. Always ignored: `contract/**` (vendored), `**/generated/**`, `**/migrations/**`, test files (`**/*.test.ts`, `tests/**`, `**/*_test.go`), `test/fixtures/**`, `tests/fixtures/**` |
| Module boundaries | dependency-cruiser (TypeScript), import-linter (Python), `go vet` + golangci-lint depguard (Go) | **a file in `services/<tool>/` imports anything outside that folder** (other than its installed dependencies); Python code changes `sys.path` or imports outside its package and `contract/`; a service imports another service; an app imports a service; `packages/*` imports a service or app; an orchestrator module imports another module's internals (only its `index.ts`); circular imports |
| Kind boundaries | dependency-cruiser + ESLint `no-restricted-imports` (Python and Go tools: import-linter, depguard) | a tool imports any `@rex/*` package; the orchestrator imports `@rex/cache`; the gateway imports `@rex/bus`; a generated tool client is used outside `@rex/cache` wrappers in workers and the gateway; Postgres drivers outside the orchestrator; `amqplib` outside `@rex/bus`; a provider SDK (any LLM SDK in the approved tables) outside a tool's LLM adapter (`src/llm/`, or its Python and Go equivalents) |
| Dependency versions | `syncpack lint` (platform) and a tool manifest lint step per language | a dependency uses a range instead of an exact version (npm range, Python pin other than `==`); platform packages disagree on a version |
| Config presets | CI script | a platform service has its own tsconfig/ESLint config that does not `extends` the root config (tools keep template copies, covered by template drift) |

Review checklist (PR template): "Did this PR define anything that already exists? Did it
copy a schema instead of `$ref`? Did it hand-edit a vendored or generated file? Did it
add an internal package or a `workspace:` link? Did it put business logic in shared
code? Did a tool gain state, auth, a bus dependency, a cache or a call to another
service? Did a tool change its output without bumping its `keyVersion`?"

## 5. When NOT to DRY

DRY stops at service boundaries for behavior:

- **No shared business logic across services.** If content-auditor needs an llms.txt
  verdict, it does not import llms-txt-generator's validator: a worker calls
  llms-txt-generator and passes the result in. Internal packages and the template never
  contain domain rules.
- **No database outside the orchestrator**, so no shared schemas exist to begin with.
  Inside the orchestrator, modules do not share tables.
- **Prefer duplication over the wrong abstraction.** Two similar-looking functions in two
  tools that change for different reasons stay separate.
- **Tests may repeat themselves** when that keeps each test readable on its own; use
  shared factories and fixtures, not shared assertions.
- **Small, stable framing is allowed.** Each spec's `info` block, `x-rex-service` block,
  and (platform specs) the `securitySchemes` `$ref` block are per-file by necessity.
- **Across tool boundaries, portability wins** ([§3](#3-portability-beats-dry-across-tool-boundaries)).
