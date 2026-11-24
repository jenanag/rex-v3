# 0040: Resolve LLM model selection and analyzer eligibility before cache lookup

- **Status:** Accepted (2026-11-25, accepted by Jay)
- **Date:** 2026-11-25
- **Deciders:** Jay Pascual
- **Amended by:** [0041](0041-standardize-tool-provider-model-selection.md), 2026-11-25 (accepted by Jay). Applies to caller cache inputs and implementation order for page descriptions and analyzer selection.

## Context

[ADR 0016](0016-cache-first.md) puts the cache at the caller, and
[ADR 0017](0017-deterministic-first-analysis.md) makes model choice explicit
where LLMs are used. [ADR 0039](0039-engine-query-per-request-model.md) applies
these rules to engine-query. The llms.txt page step and answer analysis each
need a caller rule that matches their existing request semantics.

The [describePage contract](../../packages/contracts/openapi/services/llms-txt-generator.yaml)
defaults to LLM mode and allows a deployment-selected model when omitted.
It also echoes the input URL verbatim. The
[answer-analysis contract](../../packages/contracts/openapi/services/answer-analysis.yaml)
accepts analyzer IDs from discovery for the target deployment. A successful
cached result alone cannot establish that the requested analyzer remains enabled.

## Decision

### llms-txt-generator

For the first rollout, callers pin `openai/gpt-6-luna` for `describePage`.
Apply request schema validation and the existing summarizer default first.
In LLM mode, resolve omission to the pin and validate the effective model
against the eligible models for the target deployment before lookup. Send the
effective model explicitly to the tool and hash it once as `model`. With other
inputs fixed, omission and the explicit default share a key. Distinct allowed
effective models produce distinct keys. The pin approves only the current model.

In extractive mode, schema-validate any supplied `model` and exclude it from
the key without applying the LLM allowlist. For both modes, capture the
original `/url` before normalization through the existing
`rawUrlKeyInputs` mechanism. The key must distinguish original URLs that
normalize identically because `entry.url` echoes the original.

### answer-analysis

Validate the request and check the effective analyzer IDs against current
`listAnalyzers` discovery for the target deployment before looking up a cached
analysis. Refresh or invalidate discovery when enablement flags change. A stale
or unavailable catalog cannot authorize a result-cache hit. A confirmed
disabled analyzer returns the existing HTTP 422 `unsupported_analyzer`, even
when an earlier successful result is still cached.
The refresh and invalidation mechanism belongs to runtime integration.

Preserve the order of analyzer IDs. Omitted sentiment settings use the
existing HTTP default of `det:lexicon`, and an explicit empty analyzer list
remains distinct. Language and primary selection stay with the tool.

### Offline acceptance cases

Hold request inputs and key context fixed apart from the fields under test.

| Operation | Case | Expected result |
| --- | --- | --- |
| `describePage` | Omitted LLM model vs. explicit `openai/gpt-6-luna` | Same canonical input and key. Both calls send the pinned model explicitly. |
| `describePage` | Two distinct eligible model IDs in a test-only LLM catalog | Distinct keys. An unlisted LLM model is rejected before lookup. |
| `describePage` | Extractive input with omitted, listed, or schema-valid unlisted model | Same extractive key in all three cases. A schema-invalid model still fails validation. |
| `describePage` | `https://example.org:443/guide` vs. `https://example.org/guide` | Distinct keys in each mode, preserving the different echoed URLs. |
| `analyzeAnswer` | Successful cached Luna analysis, then disable Luna and refresh or invalidate discovery | HTTP 422 `unsupported_analyzer` before result lookup. Stale or unavailable discovery also precludes a hit. |
| `analyzeAnswer` | Omitted sentiment vs. `{}` vs. explicit HTTP defaults. Empty analyzer list. Reversed analyzer order. | Retain the existing vectors for equal defaults, a distinct empty selection, and distinct keys for different analyzer orders. |

## Consequences

- The implementation PR updates the
  [caller cache policy](../../packages/contracts/cache/policy.yaml) and offline
  fixtures. Bump `llms-txt-generator.keyVersion` from `5` to `6`. Keep
  `answer-analysis.keyVersion` at `3` for eligibility-only changes if canonical
  inputs and tool outputs stay the same.
- Keep the per-page archive and read-by-reference flow under
  [ADR 0023](0023-llms-txt-pipeline.md#amendments). The tools retain their own
  catalogs and existing request and response contracts.
- Phase 3 has started and Phase 2 acceptance remains pending. Provider identity
  checks, live calls, and runtime cache integration are deferred.

## Alternatives considered

- **Add describePage discovery for the first rollout.** Discovery would support
  independently changing defaults but would add a contract and freshness rules
  for a deployment with one eligible model.
- **Hash the unresolved request.** This would split equivalent defaults,
  partition extractive results by an unused field, and permit an omitted-model
  key to outlive a change in the deployment default.
- **Partition analyzer keys by catalog revision.** That would invalidate more
  results and would still require a current catalog to reject disabled IDs.
