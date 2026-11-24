# Architecture Decision Records

One short record per significant decision. Copy [0000-template.md](0000-template.md)
and take the next number.

**Authority.** An **Accepted** ADR is binding as the current design and is never
rewritten: a change to its decision is a new ADR, Proposed until Jay accepts it, that
amends or supersedes it; the old ADR only gets a dated "Amended by NNNN" or
"Superseded by NNNN" line in its header. A **Proposed** ADR is binding as the current
design once Jay asked for it, and may be amended in place only at his request (dated in
its header). Agents never change an ADR's status. A **Superseded** ADR is history only
and is never implemented.

**Change history.** For the 2026-11-22 stateless-tools redesign (all ADRs still Proposed),
decisions that were *replaced* were superseded, so the old reasoning stays readable
(0003, 0004, 0005, 0008), and decisions that still hold with small wording changes were
amended (0001, 0002, 0006, 0007). Later the same day Jay's answers to the open
questions amended 0009, 0011 to 0015 in place (still Proposed) and added 0016 and 0017.
The portability revision added 0018 (self-contained tools) and 0019 (internal
packages) and amended 0001, 0002, 0006, 0007, 0009 and 0011 to 0016 in place. The
onboarding review amended 0018 (dependency list moved to conventions §16). Jay decided
0021 (content extraction) directly, so it was Accepted while the rest of Phase 0 awaited
his acceptance; it amended 0009, 0013, 0015 and 0016 in place, and Jay later appended
a dated amendment to it (REx defines the extractor contract; no tool fetches), which
also amended 0018 and 0019 in place. A second dated amendment to 0021 recorded Jay's
answers on the extractor's network, robots.txt, page limits, the page archive and the
seo-auditor; the archive design is 0022 (Proposed), which amended 0016 in place. Jay
then approved the event-driven llms.txt pipeline: 0023 (Proposed: it records Jay's
decisions, marked as his, and the design details that await his acceptance), with a
third dated amendment to 0021 and an in-place amendment to 0022. A dated amendment
to 0023 then moved audits to the same page-results-by-reference pattern and left the
sitemap-extractor's deployment to the implementer (both Jay's decisions). On 2026-11-22
Jay accepted Phase 0: every current ADR (all but the superseded 0003, 0004, 0005 and
0008) is Accepted, including 0023's design details. Jay then approved a multi-language
tool factory: 0024 (per-tool language) amends 0001, 0002, 0006, 0007, 0018 and 0019 by
dated "Amended by" lines. Jay accepted 0024 on 2026-11-22; his decisions at that moment
(engine-query stays TypeScript and Go starts with ai-traffic-analyzer in Phase 7; uv,
openapi-core with FastAPI, kin-openapi and the validation budgets approved; spikes right
before each tool's step; one language ADR per tool) were written into 0024 directly
before it was marked Accepted, as its header records. The Phase 1 TypeScript route-loader
spike is recorded in ADR 0020, accepted by Jay on 2026-11-22. Phase 2 opened with
[ADR 0025](0025-schema-generator-language.md), which proposed TypeScript for the
first tool, `schema-generator`. [ADR 0026](0026-typescript-validation-budget.md)
records the CI measurements and sets a single TypeScript validation budget
for all valid body sizes up to each tool's configured limit. Jay accepted both
on 2026-11-22. ADR 0026 amends the TypeScript validation budget in ADRs 0020 and 0024.
Jay accepted [ADR 0027](0027-scale-typescript-validation-budget.md) on 2026-11-23.
It amends ADR 0026 to scale the TypeScript validation budget with each tool's
effective request body limit.
Jay accepted [ADR 0028](0028-llms-txt-generator-language.md) on 2026-11-23. It selects
TypeScript for `llms-txt-generator` and records its Phase 2 build order.
Jay accepted [ADR 0029](0029-llms-txt-generator-body-limit.md) on 2026-11-23. It sets
the 12 MiB request body ceiling for `llms-txt-generator` and retains its request schemas.
Jay accepted [ADR 0030](0030-content-auditor-language.md) on 2026-11-24. It selects
TypeScript for `content-auditor` and records its Phase 2 build order.
Jay accepted [ADR 0031](0031-content-auditor-body-limits.md) on 2026-11-24.
It sets the tool-wide and public-route byte ceilings and their validator-only
CI gates for `content-auditor`.
Jay accepted [ADR 0032](0032-citation-extractor-language.md) on 2026-11-24. It selects
TypeScript for `citation-extractor` and records its Phase 2 build order.
Jay accepted [ADR 0033](0033-citation-extractor-body-limit.md) on 2026-11-24. It sets
the 4 MiB request body ceiling for `citation-extractor` and retains its request schema.

Jay accepted [ADR 0034](0034-python-validation-spike.md) on 2026-11-24. It records
that both Python validators missed the large-workload gate and keeps the Python bring-up paused.

Jay accepted [ADR 0035](0035-answer-analysis-language.md) on 2026-11-24, selecting
TypeScript for answer-analysis under the fallback in ADR 0024.

| ADR | Title | Status |
|---|---|---|
| [0001](0001-monorepo-pnpm-turborepo.md) | Monorepo with pnpm workspaces and Turborepo | Accepted (amended) |
| [0002](0002-typescript-fastify.md) | TypeScript on Node.js with Fastify | Accepted (amended) |
| [0003](0003-postgres-schema-per-service.md) | Postgres with schema-per-service ownership | Superseded by [0010](0010-orchestrator.md) |
| [0004](0004-redis-bullmq-queues.md) | Redis with BullMQ for jobs | Superseded by [0011](0011-rabbitmq-bus.md) |
| [0005](0005-auth.md) | Auth: JWT for users, API keys for clients, gateway verification | Superseded by [0014](0014-auth.md) |
| [0006](0006-contract-first-openapi.md) | Contract-first OpenAPI 3.1 with generated clients | Accepted (amended) |
| [0007](0007-dry-policy.md) | DRY policy | Accepted (amended) |
| [0008](0008-event-contracts.md) | Event contracts and delivery | Superseded by [0012](0012-bus-contracts.md) |
| [0009](0009-stateless-tool-services.md) | Stateless tool services | Accepted (amended) |
| [0010](0010-orchestrator.md) | One stateful orchestrator (modular monolith) | Accepted |
| [0011](0011-rabbitmq-bus.md) | RabbitMQ (self-hosted) as the job bus | Accepted (amended) |
| [0012](0012-bus-contracts.md) | Bus contracts: AsyncAPI messages and one topology file | Accepted (amended) |
| [0013](0013-edge-gateway.md) | A thin edge gateway in front of the orchestrator and public tools | Accepted (amended) |
| [0014](0014-auth.md) | Auth: one issuer in the orchestrator, no auth inside tools | Accepted (amended) |
| [0015](0015-stateless-workers.md) | Stateless workers chain tools | Accepted (amended) |
| [0016](0016-cache-first.md) | Cache-first tool calls (self-hosted Redis) | Accepted (amended) |
| [0017](0017-deterministic-first-analysis.md) | Deterministic first, LLMs optional and comparable | Accepted (amended) |
| [0018](0018-tool-portability.md) | Tool portability: every tool is a self-contained project | Accepted |
| [0019](0019-internal-packages.md) | Internal packages: only where unavoidable, published and pinned | Accepted |
| [0020](0020-fastify-openapi-validation.md) | Bind Fastify routes to the vendored OpenAPI 3.1 contract | Accepted (amended) |
| [0021](0021-content-extraction.md) | Content extraction via external content-extractor, called by workers on orchestrator-issued jobs | Accepted (decided by Jay) |
| [0022](0022-page-archive.md) | Pages are archived to the external data-aggregator at capture time, before they are cached | Accepted |
| [0023](0023-llms-txt-pipeline.md) | The llms.txt crawl is an event-driven pipeline: sitemap discovery, page audits, LLM-free assembly | Accepted |
| [0024](0024-per-tool-language.md) | Per-tool implementation language: TypeScript, Python or Go behind the same contract | Accepted (amended) |
| [0025](0025-schema-generator-language.md) | Use TypeScript for schema-generator | Accepted |
| [0026](0026-typescript-validation-budget.md) | Keep one TypeScript request validation budget | Accepted (amended) |
| [0027](0027-scale-typescript-validation-budget.md) | Scale the TypeScript validation budget with the body limit | Accepted |
| [0028](0028-llms-txt-generator-language.md) | Use TypeScript for llms-txt-generator | Accepted |
| [0029](0029-llms-txt-generator-body-limit.md) | Set the llms-txt-generator request body limit to 12 MiB | Accepted |
| [0030](0030-content-auditor-language.md) | Use TypeScript for content-auditor | Accepted |
| [0031](0031-content-auditor-body-limits.md) | Set request body limits for content-auditor | Accepted |
| [0032](0032-citation-extractor-language.md) | Use TypeScript for citation-extractor | Accepted |
| [0033](0033-citation-extractor-body-limit.md) | Set the citation-extractor request body limit to 4 MiB | Accepted |
| [0034](0034-python-validation-spike.md) | Evaluate Python request validation against the vendored OpenAPI contract | Accepted |
| [0035](0035-answer-analysis-language.md) | Use TypeScript for answer-analysis | Accepted |

Statuses: Proposed, Accepted, Superseded by NNNN, Deprecated.
