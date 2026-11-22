# 0001: Monorepo with pnpm workspaces and Turborepo

- **Status:** Accepted (2026-11-22, accepted by Jay)
- **Date:** 2026-11-22
- **Deciders:** Jay Pascual
- **Amended:** 2026-11-22, for the stateless-tools redesign (allowed while Proposed; see [README](README.md))
- **Amended:** 2026-11-22: tool portability ([ADR 0018](0018-tool-portability.md)) and internal packages ([ADR 0019](0019-internal-packages.md))
- **Amended by:** [0024](0024-per-tool-language.md), 2026-11-22 (accepted by Jay): tool folders may be Python (uv) or Go (Go modules) projects as well as npm projects; still not workspace members

## Context

REx has a gateway, an orchestrator, a workers service, a dozen tool services, 2 apps and about
a dozen shared packages, all in TypeScript, with
contracts that reference each other across folders. Separate repos would make
cross-cutting changes (a shared error schema, a new bus message) span many PRs and version
bumps, and would encourage copying.

## Decision

One Git monorepo. Platform code (`apps/*`, the gateway, orchestrator and workers,
`packages/cache`, `packages/bus`) is a pnpm workspace with Turborepo for task
orchestration and caching; CI runs only affected tasks (`turbo run ...
--filter=...[origin/main]`). **Tools are not workspace members**: each tool folder is a
standalone npm project with its own lockfile ([ADR 0018](0018-tool-portability.md)), and
CI runs each changed tool on its own. Internal packages are published and pinned, never
linked with `workspace:*` ([ADR 0019](0019-internal-packages.md)). Dependencies use
exact versions in each `package.json`; `syncpack` keeps platform versions aligned and
Renovate opens grouped upgrades. Each service builds its own image and deploys
independently.

## Consequences

- One PR can change a contract and every consumer atomically; contract CI checks see
  all specs at once.
- Module boundaries are not enforced by repo walls, so dependency-cruiser and ESLint
  rules must enforce them ([dry-rule.md §4](../dry-rule.md#4-enforcement)).
- Remote caching is needed once CI time grows.

## Alternatives considered

- **Polyrepo**: strongest isolation, but contract changes become multi-repo releases and
  shared components get copied.
- **Nx**: more features (generators, graph, boundaries), more configuration and lock-in;
  Turborepo plus small scripts covers the need.
- **npm or Yarn workspaces**: pnpm is faster, stricter about phantom dependencies, and
  has catalogs.
