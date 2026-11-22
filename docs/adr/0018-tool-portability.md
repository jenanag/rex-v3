# 0018: Tool portability: every tool is a self-contained project

- **Status:** Accepted (2026-11-22, accepted by Jay)
- **Date:** 2026-11-22
- **Deciders:** Jay Pascual
- **Amends:** [0001](0001-monorepo-pnpm-turborepo.md), [0002](0002-typescript-fastify.md),
  [0006](0006-contract-first-openapi.md), [0007](0007-dry-policy.md),
  [0009](0009-stateless-tool-services.md), [0014](0014-auth.md)
- **Amended:** 2026-11-22 (onboarding review, at Jay's request): the package table moved
  to conventions §16 as the single approved dependency list
- **Amended:** 2026-11-22, at Jay's request: tools never fetch, so the template has no fetch helper ([ADR 0021](0021-content-extraction.md))
- **Amended by:** [0024](0024-per-tool-language.md), 2026-11-22 (accepted by Jay): "a complete npm project" becomes a complete project in its language (lockfile, public registry, Dockerfile, the same portability job)

## Context

Tool development is the top priority. Tools are request-in, response-out functions
([ADR 0009](0009-stateless-tool-services.md)), so they can be built and tested on their
own, but the first design tied them to the monorepo: `$ref`s into
`packages/contracts`, `workspace:*` links to internal packages (`http`, `auth`,
`config`, `observability`, `llm-clients`, `scraper`, `sdk`) and pnpm catalogs. A tool
could not be copied out, handed to a contractor, or built in a clean container without
the rest of the repo. Jay asked that tools be developable on their own and that public
npm packages replace internal ones wherever possible.

## Decision

**A tool folder is a complete npm project.** Copy `services/<tool>/` anywhere, then
`npm ci && npm run build && npm test && docker build .` works with nothing else
present: no parent `package.json`, workspace, `.npmrc`, `packages/` or network service.

- **Own dependencies, public only.** Each tool has its own `package.json` and committed
  `package-lock.json` (npm, not pnpm), exact versions, installed from the public npm
  registry. No `workspace:`, `file:`, `link:` or `portal:` specifiers and no `@rex/*`
  package. Tools are not members of the pnpm workspace.
- **Well-known public packages instead of internal ones:** Fastify and its plugins,
  Ajv, `env-schema`, `pino`, OpenTelemetry, the official LLM SDKs, `undici`, `cheerio`
  and `robots-parser`. The approved list, which tools get which package, and how to
  add one (Jay approves) live in
  [conventions §16](../conventions.md#approved-tool-dependencies), the single source.

- **Contracts are vendored, not referenced.** The single source of every contract stays
  in `packages/contracts` (DRY for contracts). Each tool gets a generated,
  self-contained copy in `services/<tool>/contract/`: its spec bundled into one
  `openapi.yaml` (no external `$ref`), generated `types.ts`, and any data file it needs
  (content-auditor: `ai-crawlers.yaml`). What goes where is listed once in
  [`packages/contracts/vendoring.yaml`](../../packages/contracts/vendoring.yaml);
  `scripts/vendor-contracts` writes the copies and CI regenerates them and fails on
  any difference. Contract changes are made in `packages/contracts` and re-vendored;
  outside the repo, `contract/` is read-only.
- **Boilerplate is generated, not shared.** Server bootstrap, error mapping
  (problem+json), health probes, config, telemetry and the LLM adapter come from
  `services/_template` through `scripts/new-tool`. Each generated
  file is listed with the template version and a hash in the tool's
  `.template.json`; CI reports drift, and `scripts/new-tool --upgrade <tool>` brings a
  tool to the current template. A tool may take ownership of a file (`owned: true`),
  which removes it from drift checks.
- **LLM adapter per tool.** A tiny `src/llm/` adapter (from the template) wraps the
  official SDKs behind one function and maps provider usage to `LlmUsage`.
  `LLM_MODE=mock` (the default in tests) answers from recorded fixtures or a
  deterministic stub: no keys, no network, no cost. `LLM_MODE=record` refreshes
  fixtures on a developer machine with real keys.
- **No auth inside tools** ([ADR 0014](0014-auth.md)): no token verification, no auth
  dependency, no auth configuration. Access is enforced in front of them.
- **Cache and bus stay outside** (ADRs [0015](0015-stateless-workers.md),
  [0016](0016-cache-first.md)).
- **CI proves it.** A portability job copies each tool to a temp directory outside the
  checkout and runs `npm ci`, build, tests (`LLM_MODE=mock`, network disabled) and
  `docker build`, then starts the image and calls `/healthz`. Other jobs: contract drift,
  template drift, lint, jscpd (scoped, see [dry-rule.md](../dry-rule.md#4-enforcement)),
  and dependency-cruiser forbidding any import that leaves the tool folder.

## Consequences

- A tool can be developed, reviewed and shipped by someone who has only its folder.
  Tools build in parallel with no shared build graph.
- Some code repeats across tools (bootstrap, adapters). It is generated from one
  template and drift is detected, so the knowledge still has one source
  ([dry-rule.md](../dry-rule.md#3-portability-beats-dry-across-tool-boundaries)).
- Dependency upgrades happen per tool (Renovate groups them); versions may differ
  between tools for a while, which is acceptable because tools share no runtime.
- Vendored copies make contract changes two-step (edit source, re-vendor); CI makes a
  forgotten step impossible to merge.

## Alternatives considered

- **Shared internal packages via `workspace:*`** (first design): DRY code, but tools
  cannot leave the repo and every package change rebuilds every tool.
- **Internal packages published to a private registry for tools**: portable, but each
  tool still depends on REx release cadence and registry credentials; the template plus
  public packages covers the same needs.
- **Polyrepo per tool**: maximal isolation, but contracts would be copied between repos
  without a single source; vendoring from one repo keeps the source single.
- **Git submodules or subtree for contracts**: fragile tooling; vendored generated files
  are simpler to review and diff.
