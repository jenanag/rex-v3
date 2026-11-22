# 0006: Contract-first OpenAPI 3.1 with generated clients

- **Status:** Accepted (2026-11-22, accepted by Jay)
- **Date:** 2026-11-22
- **Deciders:** Jay Pascual
- **Amended:** 2026-11-22, for the stateless-tools redesign (allowed while Proposed; see [README](README.md))
- **Amended:** 2026-11-22: tool portability ([ADR 0018](0018-tool-portability.md)) and internal packages ([ADR 0019](0019-internal-packages.md))
- **Amended by:** [0024](0024-per-tool-language.md), 2026-11-22 (accepted by Jay): tool types are generated per language (openapi-typescript, datamodel-code-generator, oapi-codegen); the vendored spec stays the validator

## Context

The gateway, the orchestrator, every tool service, a dashboard, public API clients and docs all depend on the same HTTP
contracts. Hand-written clients and types drift from servers.

## Decision

- Every service's REST contract is
  `packages/contracts/openapi/services/<name>.yaml` (OpenAPI 3.1, JSON Schema 2020-12),
  written and reviewed **before** its code. Services build from a vendored,
  self-contained bundle in `services/<name>/contract/`
  ([ADR 0018](0018-tool-portability.md)), never from the source files.
- Shared parts live once in `packages/contracts/openapi/common.yaml` and are `$ref`'d.
- Redocly CLI is the single linter and bundler (config: `redocly.yaml`). Bundled specs
  feed the server validator, the generated types and clients, and the docs.
- Types and clients are generated (`openapi-typescript` types + `openapi-fetch`) by each
  consumer from its vendored copies and never edited by hand; there is no shared SDK
  package ([ADR 0019](0019-internal-packages.md)). The dashboard calls the orchestrator,
  and workers call tools, only through generated clients.
- Each spec declares `x-rex-service` (`name`, `kind`). The gateway route table is
  generated from the orchestrator spec plus the tool operations marked
  `x-rex-public: true` ([ADR 0013](0013-edge-gateway.md)).
- Contract tests validate real responses against the spec in CI.

## Consequences

- Clients, servers and docs cannot drift silently.
- Specs are verbose; shared components and lint rules keep them consistent.
- Breaking changes are visible in review as spec diffs.

## Alternatives considered

- **Code-first (generate spec from code)**: specs become an afterthought and cross-spec
  `$ref`s are hard.
- **tRPC / GraphQL**: great for one TS client, but REx sells a public REST API.
- **Spectral as linter**: capable, but Redocly also bundles and builds docs; using both
  would duplicate rules.
