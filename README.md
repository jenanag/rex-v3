# REx v3: AI answer optimization platform

REx measures and improves how brands appear in AI-generated answers: Answer Engine
Optimization (AEO), Generative Engine Optimization (GEO) and AI answer optimization
([glossary](docs/glossary.md)). It tracks prompts across ChatGPT, Claude, Gemini,
Perplexity and Grok; measures brand mentions, share of voice, sentiment and citations
against competitors; and provides tools that fix what it finds: content audits, AI
crawler checks, schema markup, llms.txt, rewrites and entity optimization.

It is a monorepo with contract-first OpenAPI 3.1 and AsyncAPI specs:

- **Stateless tool services** (engine-query, answer-analysis, citation-extractor,
  content-auditor, schema-generator, llms-txt-generator, more later): request in,
  response out; no database, no bus, no auth, no calls to each other. **Each tool is a
  self-contained project in its language**: copy its folder anywhere and it installs,
  builds, tests and runs in Docker on its own, with public packages and a vendored copy
  of its contract ([ADR 0018](docs/adr/0018-tool-portability.md)). TypeScript by
  default; Python or Go where the tool's own ADR chooses it, behind the same contract
  ([ADR 0024](docs/adr/0024-per-tool-language.md)).
- **Platform** (pnpm + Turborepo workspace): the orchestrator, workers, gateway and the
  only two internal packages, `@rex/cache` and `@rex/bus`, published and pinned
  ([ADR 0019](docs/adr/0019-internal-packages.md)).
- **One stateful orchestrator**: the only database owner and writer; accounts,
  projects, tracking, schedules, billing, alerts; publishes jobs, consumes results.
- **Stateless workers**: consume jobs from RabbitMQ, chain tool calls over REST,
  publish results.
- **A thin edge gateway**: auth resolution, rate limits, routing to the orchestrator and
  to public free-tool operations.
- **Cache first**: workers and the gateway check a shared, self-hosted Redis cache before
  any tool call, so repeated and redelivered work never pays twice.
- **Deterministic first**: non-LLM methods wherever feasible (mentions, sentiment
  lexicons, audits); LLM methods are optional and comparable side by side.

**Status: Phase 0 accepted by Jay on 2026-11-22.** The [ADR index](docs/adr/README.md)
records the decisions, including ADR 0024 for TypeScript, Python and Go tools. Phase 1
was completed on 2026-11-22. The [roadmap](docs/roadmap.md) tracks the tool factory, including
contract vendoring, the tool template and portability CI. Phase 2 has started.
Jay accepted ADRs 0025 and 0026 on 2026-11-22. Phase 2 builds the tools one at
a time, before the platform. Open choices are tracked as
[deferred decisions](docs/roadmap.md#deferred-decisions).

**Coding agents** (Cursor, Claude Code, Codex, Copilot): start at [AGENTS.md](AGENTS.md).

## How the docs are organized

Each topic has exactly one home (the [DRY rule](docs/dry-rule.md) applies to docs too).
Other pages link to it rather than repeat it.

| Question | Single source |
|---|---|
| What is the system, what talks to what, who owns which data? | [docs/architecture.md](docs/architecture.md) |
| How do we name, version, paginate, error, authenticate, log? | [docs/conventions.md](docs/conventions.md) |
| What may be shared and how is duplication prevented (and where portability wins)? | [docs/dry-rule.md](docs/dry-rule.md) |
| How are tool calls cached (keys, modes, scope, TTLs and their overrides)? | [packages/contracts/cache/policy.yaml](packages/contracts/cache/policy.yaml), overview in [docs/architecture.md#caching](docs/architecture.md#caching) |
| Which bus messages exist, who produces and consumes them, how is delivery guaranteed? | [events.yaml](packages/contracts/asyncapi/events.yaml) + [topology.yaml](packages/contracts/bus/topology.yaml), catalog and delivery rules in [docs/events.md](docs/events.md) |
| What does a term or metric mean? | [docs/glossary.md](docs/glossary.md) |
| What gets built when, and when is a phase done? | [docs/roadmap.md](docs/roadmap.md) |
| Why was a decision made? | [docs/adr/](docs/adr/README.md) |
| What does service X do? | [docs/services/](docs/services/) |
| What exactly does endpoint Y accept and return? | `packages/contracts/openapi/services/<name>.yaml` (tools also carry a vendored copy in `services/<tool>/contract/`) |
| Which components are shared by every API? | [packages/contracts/openapi/common.yaml](packages/contracts/openapi/common.yaml) |

## Link map

- **Architecture:** [repo layout](docs/architecture.md#repository-layout) ·
  [service map and kinds](docs/architecture.md#service-map) ·
  [data ownership](docs/architecture.md#data-ownership) ·
  [communication](docs/architecture.md#communication) ·
  [job lifecycle](docs/architecture.md#job-lifecycle) ·
  [caching](docs/architecture.md#caching) ·
  [scheduling with replicas](docs/architecture.md#scheduling-with-2-orchestrator-replicas) ·
  [gateway flow](docs/architecture.md#gateway-flow) ·
  [tenancy](docs/architecture.md#tenancy-model-org--project--brand) ·
  [LLM concurrency and cost](docs/architecture.md#llm-concurrency-and-cost)
- **Rules:** [conventions](docs/conventions.md) · [DRY rule](docs/dry-rule.md) · [bus messages and delivery](docs/events.md) · [glossary](docs/glossary.md)
- **Decisions:** [ADR index](docs/adr/README.md): 0001 monorepo · 0002 TypeScript + Fastify · 0006 contract-first OpenAPI · 0007 DRY policy · 0009 stateless tools · 0010 orchestrator · 0011 RabbitMQ bus · 0012 bus contracts · 0013 edge gateway · 0014 auth · 0015 stateless workers · 0016 cache first · 0017 deterministic first · 0018 tool portability · 0019 internal packages · 0020 Fastify validation · 0021 content extraction · 0022 page archive · 0023 llms.txt pipeline · 0024 per-tool language · 0025 schema-generator language · 0026 TypeScript validation budget (0003, 0004, 0005 and 0008 are superseded; 0020 is Accepted; statuses in the index)
- **Contracts:** [common.yaml](packages/contracts/openapi/common.yaml) · [events.yaml](packages/contracts/asyncapi/events.yaml) · [topology.yaml](packages/contracts/bus/topology.yaml) · [policy.yaml](packages/contracts/cache/policy.yaml) · [ai-crawlers.yaml](packages/contracts/data/ai-crawlers.yaml) · [vendoring.yaml](packages/contracts/vendoring.yaml) · [contracts README](packages/contracts/README.md)
- **Services** (doc · spec):
  - Platform: [gateway](docs/services/gateway.md) · [spec](packages/contracts/openapi/services/gateway.yaml) | [orchestrator](docs/services/orchestrator.md) · [spec](packages/contracts/openapi/services/orchestrator.yaml) | [workers](docs/services/workers.md)
  - Tools: [engine-query](docs/services/engine-query.md) · [spec](packages/contracts/openapi/services/engine-query.yaml) | [answer-analysis](docs/services/answer-analysis.md) · [spec](packages/contracts/openapi/services/answer-analysis.yaml) | [citation-extractor](docs/services/citation-extractor.md) · [spec](packages/contracts/openapi/services/citation-extractor.yaml) | [content-auditor](docs/services/content-auditor.md) · [spec](packages/contracts/openapi/services/content-auditor.yaml) | [schema-generator](docs/services/schema-generator.md) · [spec](packages/contracts/openapi/services/schema-generator.yaml) | [llms-txt-generator](docs/services/llms-txt-generator.md) · [spec](packages/contracts/openapi/services/llms-txt-generator.yaml)
  - External (built outside this repo, called only by workers): [content-extractor](docs/services/content-extractor.md) · [spec](packages/contracts/openapi/services/content-extractor.yaml) | [sitemap-extractor](docs/services/sitemap-extractor.md) · [spec](packages/contracts/openapi/services/sitemap-extractor.yaml) | [data-aggregator](docs/services/data-aggregator.md) | [seo-auditor](docs/services/seo-auditor.md)
  - Later tools: [notifier](docs/services/notifier.md) | [report-renderer](docs/services/report-renderer.md) | [query-discovery](docs/services/query-discovery.md) | [content-rewriter](docs/services/content-rewriter.md) | [entity-optimizer](docs/services/entity-optimizer.md) | [ai-traffic-analyzer](docs/services/ai-traffic-analyzer.md)

## Validate the contracts

Run the pinned validators and cross-file checks from the repo root. The
[commands in AGENTS.md](AGENTS.md#works-today-phase-1) also cover vendoring, generated
docs, and template drift.

Expect zero OpenAPI errors. The linter can warn about missing 4xx responses on
health probes, the JWKS endpoint, and parameterless tool lists. The
[Phase 1 CI jobs](docs/roadmap.md#15-ci-with-the-portability-check) run the same
contract checks and verify that each changed tool works in isolation.
