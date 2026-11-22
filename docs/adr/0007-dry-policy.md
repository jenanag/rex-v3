# 0007: DRY policy

- **Status:** Accepted (2026-11-22, accepted by Jay)
- **Date:** 2026-11-22
- **Deciders:** Jay Pascual
- **Amended:** 2026-11-22, for the stateless-tools redesign (allowed while Proposed; see [README](README.md))
- **Amended:** 2026-11-22: tool portability ([ADR 0018](0018-tool-portability.md)) and internal packages ([ADR 0019](0019-internal-packages.md))
- **Amended by:** [0024](0024-per-tool-language.md), 2026-11-22 (accepted by Jay): one tool per job now means one per language for tests, lint and format; jscpd and the contract checks stay single

## Context

A monorepo with many similar services invites copy-paste: error schemas, pagination,
auth middleware, configs, bus messages and queue definitions. Copies drift and cause inconsistent APIs. At
the same time, over-sharing between services creates a distributed monolith.

## Decision

Adopt the rule in [dry-rule.md](../dry-rule.md): every piece of knowledge has one
source of truth and is referenced or generated elsewhere; shared contracts are
promoted at their second consumer; shared code needs three real uses and must be
technical; business logic is never shared across services. **Portability beats DRY
across tool boundaries** ([ADR 0018](0018-tool-portability.md)): contracts keep one
source but are vendored into tools as generated copies, and tool boilerplate is
generated from one template instead of shared as code; CI detects drift of both. Bus messages are defined
once in AsyncAPI and the broker topology once in `bus/topology.yaml`; job payloads `$ref`
tool schemas instead of restating them. The rule is enforced in CI (Redocly, AsyncAPI
validation, `check-contracts`, contract and template drift, jscpd,
dependency-cruiser, ESLint restricted imports, syncpack, codegen diff).

## Consequences

- Consistent contracts and less code to maintain; one change updates every consumer.
- Shared components become a coordination point; changes to common.yaml need review
  from every affected service owner and must be additive within v1.
- Some intentional duplication remains (per-tool helpers that change for different
  reasons, readable tests).

## Alternatives considered

- **No formal policy**: drift is invisible until clients break.
- **Maximal sharing (shared domain packages, shared DB schema)**: couples services and
  removes independent deployability.
