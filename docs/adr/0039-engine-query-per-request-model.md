# 0039: Allow per-request model selection in engine-query

- **Status:** Accepted (2026-11-25, accepted by Jay)
- **Date:** 2026-11-25
- **Deciders:** Jay Pascual
- **Amended by:** [0041](0041-standardize-tool-provider-model-selection.md), 2026-11-25 (accepted by Jay). Applies to engine-query provider and model selection, discovery, and cache inputs.

## Context

The [engine-query contract](../../packages/contracts/openapi/services/engine-query.yaml)
reports the deployment's model for each engine in discovery. The query request
selects an engine. [ADR 0017](0017-deterministic-first-analysis.md) calls for
letting callers choose the LLM model so results can be compared. The caller
must also distinguish results from different models under
[ADR 0016](0016-cache-first.md). [ADR 0037](0037-engine-query-language.md)
remains the language and template decision.

## Decision

Add an optional `model` field to the internal `POST /v1/engine-answers` request.
The engine identifies the provider, and `model` selects an exact model ID
from that engine's deployment allowlist. Omission selects the engine's
current default. ChatGPT keeps `gpt-6-luna`, and Gemini keeps
`gemini-3.5-flash-lite`. Each allowlist starts with its current default.
Any later addition requires approval and verification of provider compatibility,
search capability, and metering. Each call still sends one prompt to one engine.

Keep the existing `model` in `GET /v1/engines` as the default and add
`allowedModels` with the IDs the deployment accepts for that engine, including
the default. Use the
same deployment catalog for discovery and request validation. For a
schema-valid model outside the selected engine's allowlist, return the shared
HTTP 422 Problem with code `unsupported_model` and detail identifying `/model`
before cache lookup or any provider call. Schema-invalid requests retain HTTP 400.

[ADR 0038](0038-engine-query-selectable-web-search.md) continues to govern
search capability and defaults. ChatGPT still defaults to required hosted
search and accepts explicit `false` for text-only generation. Gemini still
defaults to text-only generation and rejects explicit `true` before any
provider call. Discovery's `webSearch` still reports engine capability.
[Opt-in Gemini search](../roadmap.md#opt-in-gemini-web-search) remains deferred.

### Caller cache identity

Before cache lookup, resolve the effective model against the selected engine's
deployment catalog and apply ADR 0038's effective search rules. Reject
unsupported model or search selections before using the cache. Send the
resolved model explicitly to the tool so lookup and execution use the same
selection. Populate the existing `engineModel` extra key input with that
effective ID, which the [caller cache policy](../../packages/contracts/cache/policy.yaml)
serializes as `$engineModel`. Exclude the optional request `model` field from
the canonical input used for hashing. Preserve the effective `webSearch`
boolean in that input.

Future golden vectors hold the other request inputs, cache scope, window, and
sample constant within each comparison:

| Selection | Expected key behavior |
| --- | --- |
| ChatGPT omits `model` vs. explicitly requests `gpt-6-luna` | Same key with `$engineModel` set to `gpt-6-luna` |
| Gemini omits `model` vs. explicitly requests `gemini-3.5-flash-lite` | Same key with `$engineModel` set to `gemini-3.5-flash-lite` |
| Same engine selects two distinct allowed model IDs in a test-only catalog | Different keys |
| Same ChatGPT model with omitted `webSearch` vs. explicit `true`, and then explicit `false` | Omission and `true` share a key. `false` gets a distinct key |
| Same Gemini model with omitted `webSearch` vs. explicit `false`, and then explicit `true` | Omission and `false` share a key. Reject `true` before lookup |

## Consequences

- Callers can pin the model for comparison while existing requests keep their
  defaults. The tool remains stateless and the cache stays with callers.
- Implement the optional request field and additive discovery field on `/v1`
  under [conventions §3](../conventions.md#3-versioning). Apply the caller
  policy and golden vectors in the implementation PR. The changed discovery
  output calls for an `engine-query.keyVersion` bump under
  [conventions §15](../conventions.md#15-caching).
- Phase 2 acceptance remains pending. This decision adds model choice within
  an engine, and the three-engine sources-and-usage criterion still applies.
  Contract and policy edits, implementation, tests, and live verification
  are deferred to follow-up work.

## Alternatives considered

- **Keep a single deployment-selected model per engine.** Deployment
  configuration stays simple, but a caller cannot pin or compare models on
  the same engine.
- **Accept any provider model ID.** This gives callers more choice but allows
  unverified search behavior, usage formats, and pricing.
- **Hash the raw model override.** This would split omitted and explicit
  defaults into separate entries for the same effective request.
