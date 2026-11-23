# AGENTS.md: start here (coding agents)

The canonical entry point for any coding agent (Cursor, Claude Code, Codex, Copilot, ...).
`CLAUDE.md`, `.cursor/rules/rex.mdc` and `.github/copilot-instructions.md` only point here. This file links
to the docs instead of restating them; when a link and this file disagree, the linked doc wins, and you should flag the mismatch.

## What REx is

REx measures and improves how brands appear in AI-generated answers (AEO/GEO).
Stateless **tool services** do the work (query an engine, analyze an answer, audit a
page); one stateful **orchestrator** owns all data; stateless **workers** chain tools
through a self-hosted RabbitMQ bus; a thin **gateway** sits at the edge. Details:
[README](README.md), [architecture](docs/architecture.md).

**Current phase:** 2

**Status:** Phase 0 (docs and contracts) was accepted by Jay on 2026-11-22. ADRs 0001
to 0023 were Accepted except 0020 (reserved at Phase 0 acceptance) and the superseded
0003, 0004, 0005 and 0008. Jay accepted ADRs 0020 and 0024 on 2026-11-22.
Phase 1 was completed on 2026-11-22. Phase 2 has started. Jay accepted ADRs 0025
and 0026 on 2026-11-22, ADR 0027, ADR 0028, and ADR 0029 on 2026-11-23, and ADR 0030
on 2026-11-24. ADR 0031 is Proposed. Docs and contracts change at Jay’s request. A new ADR amends or supersedes an Accepted decision.

See the [roadmap](docs/roadmap.md) for the build order and review gates.

## Hard rules

Breaking one of these fails review even if CI is green.

1. **Tools are stateless and self-contained.** A tool folder `services/<tool>/` must
   install, build, test and run in Docker when copied anywhere on its own, in its
   language: TypeScript, or Python or Go where its own ADR chooses it
   ([ADR 0018](docs/adr/0018-tool-portability.md), [ADR 0024](docs/adr/0024-per-tool-language.md),
   [conventions §16](docs/conventions.md#16-tool-portability)).
2. **No auth, cache, bus or database in tools, and tools never retry.** Tool specs
   declare `security: []`; access is enforced in front of tools
   ([ADR 0014](docs/adr/0014-auth.md), [ADR 0009](docs/adr/0009-stateless-tool-services.md));
   callers own retries ([conventions §16](docs/conventions.md#16-tool-portability)).
   Tools never touch the network except LLM APIs: only workers call the external
   services (content-extractor, sitemap-extractor, data-aggregator, seo-auditor), no
   service touches the bus, and only external services read websites; the
   orchestrator, gateway and tools never do ([ADR 0021](docs/adr/0021-content-extraction.md),
   [ADR 0022](docs/adr/0022-page-archive.md)).
3. **No imports outside a tool's folder**, not even types or test helpers.
4. **No `workspace:`, `file:`, `link:` or `portal:` dependencies and no `@rex/*`
   packages in tools** (Python and Go: no path, git or editable sources, no `replace`). Only [approved packages](docs/conventions.md#approved-tool-dependencies)
   (new ones need Jay's approval), exact versions, committed lockfile. Internal
   packages exist only per [ADR 0019](docs/adr/0019-internal-packages.md).
5. **Contracts are edited only in `packages/contracts`, then vendored** into the
   services listed in [vendoring.yaml](packages/contracts/vendoring.yaml)
   ([ADR 0006](docs/adr/0006-contract-first-openapi.md)). Contract first: change the spec before the code.
   Any contract change that rejects a previously valid request bumps info.version major (docs/conventions.md §3).
6. **Never hand-edit generated files**: anything under `services/*/contract/`, the
   per-tool `AGENTS.md`, files marked `GENERATED - DO NOT EDIT`, and the blocks between
   `<!-- GENERATED:... START -->` and `END` in docs.
7. **Accepted ADRs (and Proposed ones Jay asked for) are binding as the current design;
   superseded ADRs are history only** (0003, 0004, 0005, 0008). Never implement or cite a superseded ADR as current
   ([ADR authority](docs/adr/README.md)).
8. **DRY within boundaries; portability beats DRY across tool boundaries**
   ([dry-rule.md](docs/dry-rule.md), especially [§3](docs/dry-rule.md#3-portability-beats-dry-across-tool-boundaries)). `$ref` shared
   contract parts; never share business logic between services.
9. **Deterministic first**: offer a non-LLM method where feasible; LLM methods take the
   model as input and are comparable ([ADR 0017](docs/adr/0017-deterministic-first-analysis.md)).
10. **Cache first, outside tools**: workers and the gateway check the cache before any
    tool call; tools never mention the cache ([ADR 0016](docs/adr/0016-cache-first.md),
    [policy.yaml](packages/contracts/cache/policy.yaml)).

## Where to look

| Task | Read first |
|---|---|
| Understand the system, kinds of service, who calls whom | [architecture.md](docs/architecture.md) |
| Naming, REST style, errors, IDs, env vars, logging | [conventions.md](docs/conventions.md) |
| Decide whether something may be shared or copied | [dry-rule.md](docs/dry-rule.md) |
| Work on one tool (scope, limits, shared schemas, packages) | its `services/<tool>/AGENTS.md`, then [docs/services/](docs/services/) |
| Use or add a package in a tool (any language) | [approved tool dependencies](docs/conventions.md#approved-tool-dependencies) |
| A tool's language; Python and Go tools and templates | [ADR 0024](docs/adr/0024-per-tool-language.md), `language` in [vendoring.yaml](packages/contracts/vendoring.yaml), [roadmap Phase 1](docs/roadmap.md#phase-1-tool-factory-contracts-vendoring-tool-template-portability-ci) |
| Timeouts, LLM and fetch limits of a tool operation | `x-rex-limits` in its spec ([conventions §2](docs/conventions.md#sync-vs-async)) |
| TypeScript request validation budget | 5 ms p99 per MiB of the effective request body limit. [ADR 0027](docs/adr/0027-scale-typescript-validation-budget.md) |
| Change a request or response | [packages/contracts/openapi/services/](packages/contracts/openapi/services/), [common.yaml](packages/contracts/openapi/common.yaml), [contracts README](packages/contracts/README.md) |
| Add or change a bus message or queue | [events.md](docs/events.md), [events.yaml](packages/contracts/asyncapi/events.yaml), [topology.yaml](packages/contracts/bus/topology.yaml) |
| Page content for a tool, the content-extractor and its contract | [content-extractor](docs/services/content-extractor.md), [ADR 0021](docs/adr/0021-content-extraction.md), [content-extractor.yaml](packages/contracts/openapi/services/content-extractor.yaml) |
| Page results by reference (both page flows: audits and llms.txt) | [architecture](docs/architecture.md#page-results-by-reference), `PageRef` in [events.yaml](packages/contracts/asyncapi/events.yaml), `byReference` in [policy.yaml](packages/contracts/cache/policy.yaml), [ADR 0023](docs/adr/0023-llms-txt-pipeline.md#amendments) |
| The llms.txt pipeline (sitemap discovery, page audits, assembly) | [ADR 0023](docs/adr/0023-llms-txt-pipeline.md), [architecture](docs/architecture.md#llmstxt-pipeline), [sitemap-extractor](docs/services/sitemap-extractor.md), [orchestrator](docs/services/orchestrator.md#notes) |
| Page archive, data-aggregator, seo-auditor (external, interfaces unknown) | [ADR 0022](docs/adr/0022-page-archive.md), [data-aggregator](docs/services/data-aggregator.md), [seo-auditor](docs/services/seo-auditor.md) |
| Caching: keys, TTLs, scopes, overrides | [policy.yaml](packages/contracts/cache/policy.yaml), [architecture.md#caching](docs/architecture.md#caching) |
| Sentiment, analyzers, languages | [answer-analysis](docs/services/answer-analysis.md), [ADR 0017](docs/adr/0017-deterministic-first-analysis.md) |
| Auth and tenancy | [ADR 0014](docs/adr/0014-auth.md), [conventions §9-10](docs/conventions.md#9-auth-headers) |
| What to build next and when a phase is done | [roadmap.md](docs/roadmap.md) |
| A term or metric | [glossary.md](docs/glossary.md) |
| Why something is the way it is | [ADR index](docs/adr/README.md) |
| An open question | [deferred decisions](docs/roadmap.md#deferred-decisions) |

## Git workflow

Work on a branch and open a pull request. Merge to `main` only when CI is green. Never force-push or delete `main`.

## Commands

### Works today (Phase 1)

Run from the repo root with the Node.js version in `.nvmrc` and npm.

```bash
npm ci
npm run lint:openapi                      # all source OpenAPI specs
npm run validate:asyncapi                 # bus messages and topology
scripts/check-contracts                   # cross-file rules and generated drift
scripts/vendor-contracts --check          # check vendored files without writing
scripts/vendor-contracts                  # regenerate vendored contracts and types
scripts/gen-docs --check                  # check generated docs without writing
scripts/gen-docs                          # regenerate docs and per-tool AGENTS.md
npm run test:contracts                    # cross-file rule and generation fixtures
scripts/checks/run-all.sh                 # Phase 0 reference checker (python3 + PyYAML)
scripts/checks/run-all.sh --negative      # plus its eight negative suites (GNU sed)
```

For contract changes, edit the source in `packages/contracts`, run both validators,
regenerate vendored files and docs, then run the checks. See the [contracts README](packages/contracts/README.md).

The TypeScript tool factory lives in `services/_template`. Its commands are:

```bash
scripts/new-tool <name> [--lang ts|python|go] [--llm]  # Python and Go arrive at their bring-ups
scripts/new-tool --check [<tool>]                     # template drift
scripts/new-tool --upgrade <tool>                     # re-render template-owned files
scripts/tool-ci matrix                                # list the runnable tools and their languages
scripts/tool-ci duplicates                           # jscpd across tool source folders
```

The [Phase 1 CI jobs](docs/roadmap.md#15-ci-with-the-portability-check) run portability
checks on Linux with Docker.

### Inside a tool folder (from Phase 2, once the tool is scaffolded)

```bash
npm ci && npm run build && npm test           # ts; tests run with LLM_MODE=mock: no keys, no network
uv sync --frozen && uv run pytest             # python (after the Python bring-up)
go build ./... && go test ./...               # go (after the Go bring-up)
docker build -t <tool> . && docker run -p 8080:8080 <tool>
```

The tool's own `AGENTS.md` lists the exact commands for its language.

An unscaffolded tool folder contains only `AGENTS.md` and its vendored `contract/`.

## Definition of done for any change

- Contract first: the spec in `packages/contracts` changed before or with the code, and
  vendored copies regenerated (never edited); shared `common.yaml` parts changed only
  additively within `v1`.
- Tool code stays within its operation's `x-rex-limits` and uses only approved
  packages.
- The commands that exist for the current phase pass (above); nothing that is still
  planned is claimed to have run.
- Docs that own the topic are updated (one home per topic, see the table above); no
  restated content, links instead.
- The rules above still hold; the [service definition of done](docs/roadmap.md#service-definition-of-done)
  is met for any service touched.
- A tool whose output changes for the same input bumps its `keyVersion` in
  [policy.yaml](packages/contracts/cache/policy.yaml).
- The change is reported honestly: what was run, what was not, what is uncertain.

## What not to touch

- Generated files and blocks (rule 6). Change the source and regenerate instead.
- Superseded ADRs (rule 7) and any **Accepted** ADR: they are never rewritten.
- Placeholders for [deferred decisions](docs/roadmap.md#deferred-decisions) (for
  example `https://problems.rex.invalid`, retry values marked `PLACEHOLDER`, DEFAULT
  TTLs): do not replace them with your own choices.
- `common.yaml` beyond additive changes within `v1`
  ([conventions §3](docs/conventions.md#3-versioning)).
- Other tools' folders when working on one tool.

## Recording a decision

1. Copy [docs/adr/0000-template.md](docs/adr/0000-template.md) to the next free number
   (the Python and Go spikes and each tool's language ADR take the next free number
   when they run). Every tool, TypeScript
   ones included, gets a language ADR at the start of its step, accepted by Jay before
   `scripts/new-tool` (Phase 1) runs ([ADR 0024](docs/adr/0024-per-tool-language.md)).
2. Status **Proposed**; Jay is the decider and the only one who accepts it. Fill in
   context, decision, consequences and alternatives. A Proposed ADR is binding as the
   current design once Jay asked for it.
3. Add it to the table in [docs/adr/README.md](docs/adr/README.md) and link it from the
   docs it affects.
4. To change an existing decision, only at Jay's request: every Phase 0 ADR is
   **Accepted** and is never rewritten, so write a new ADR that amends or supersedes it
   and add a dated "Amended by NNNN" or "Superseded by NNNN" line to the old ADR's
   header (nothing else in it changes). A **Proposed** ADR may still be amended in place
   with a dated "Amended" line. Agents never change an ADR's status ([authority](docs/adr/README.md)).

## When unsure

- Look in the [deferred decisions](docs/roadmap.md#deferred-decisions) table first. If
  the question is listed there, keep the placeholder and do not decide it.
- If it is not listed and the docs do not answer it, stop and ask, or propose a new row
  for the table (decision, placeholder, needed-by phase) in your change description.
- Never invent product facts (domain, prices, retry values, roles), never weaken a hard
  rule to make something pass, and say clearly which checks you could not run.
