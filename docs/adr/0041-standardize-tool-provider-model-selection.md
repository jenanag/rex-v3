# 0041: Standardize provider and model selection in tool requests

- **Status:** Accepted (2026-11-25, accepted by Jay)
- **Date:** 2026-11-25
- **Deciders:** Jay Pascual
- **Amends:** [ADR 0017](0017-deterministic-first-analysis.md) for
  answer-analysis request selectors only, [ADR 0038](0038-engine-query-selectable-web-search.md)
  for the explicit search setting in engine-query requests, [ADR 0039](0039-engine-query-per-request-model.md)
  for provider and model selection in engine-query, and
  [ADR 0040](0040-llm-model-and-analyzer-cache-eligibility.md) for caller cache
  inputs and implementation order.

## Context

[ADR 0017](0017-deterministic-first-analysis.md) gives callers control over model
selection. Today engine-query takes an engine, optionally with a model.
llms-txt-generator uses a qualified model string, and answer-analysis encodes
LLM selections in analyzer IDs. These development APIs are internal. Planned
workers, orchestration contracts, and offline checks already reference them.
[ADR 0016](0016-cache-first.md) puts result lookup and key derivation with callers.

## Decision

Jay approved a pre-release exception to [conventions §3](../conventions.md#3-versioning)
for these three tool contracts. Replace their development shapes in place on
`/v1` in one coordinated cutover. At implementation, bump each OpenAPI
`info.version` major from the reviewed baseline.

| Tool | Current | Cutover |
| --- | --- | --- |
| engine-query | 2.2.0 | 3.0.0 |
| llms-txt-generator | 4.0.1 | 5.0.0 |
| answer-analysis | 2.1.1 | 3.0.0 |

The exception excludes legacy translations, dual-format handling, deprecation
headers and windows, and parallel `/v2` routes. Conventions §3 continues to
govern other contracts.

Define one shared OpenAPI `ProviderModel` schema in
[common.yaml](../../packages/contracts/openapi/common.yaml). It requires exact,
nonempty `provider` and `model` strings, for example
`{"provider":"openai","model":"gpt-6-luna"}`. Compose it into requests that put
the fields at the top level and use it as the object form of an analyzer
selector. Close each containing schema against extra fields. Preserve the
provider-native model string exactly. Each tool's local catalog remains
authoritative for eligible pairs, capabilities, and rates.

### engine-query

Require top-level `provider`, `model`, `webSearch`, and `prompt`. Keep
`locale` and `country` optional with their existing HTTP defaults. Remove
`engine` from the tool request. Use the exact pair for lookup and pass its
model unchanged to the provider. Discovery lists supported pairs and their
capabilities. The tool answer replaces its engine field with direct `provider` and `model` fields.
The currently supported pairs remain OpenAI Luna and Google Gemini 3.5
Flash-Lite. Callers choose `webSearch` explicitly. Required search and text-only
behavior still follow ADR 0038, including Gemini's text-only capability and
deferred web search.

`POST /v1/engine-answers`

```json
{
  "provider": "openai",
  "model": "gpt-6-luna",
  "webSearch": true,
  "prompt": "What does the Parks Canada Discovery Pass cover?",
  "locale": "en-CA",
  "country": "CA"
}
```

Keep product tracking engine labels, metrics dimensions, and per-engine
queue routing in the platform. The orchestrator resolves tracking settings
to the explicit pair and search mode. Carry the tracking engine separately
from the tool payload in jobs and results that need it. The pair is the tool
selection. The tracking label remains available in stored answers and the
existing routing key `answer-capture.requested.{engine}`.

### llms-txt-generator

Require the top-level pair in LLM mode, including when the existing
`summarizer` default selects LLM mode. The first-rollout caller explicitly
sends the pinned Luna pair. Extractive requests omit both fields and remain
deterministic. Keep ADR 0040's original URL keying for both modes.

`POST /v1/llms-txt/page-entries`, LLM mode

```json
{
  "url": "https://example.org/guide",
  "metadata": {"title": "Setup Guide", "description": null, "canonicalUrl": null, "language": "en"},
  "content": {"text": "Run setup before starting the service.", "markdown": ""},
  "summarizer": "llm",
  "provider": "openai",
  "model": "gpt-6-luna"
}
```

`POST /v1/llms-txt/page-entries`, extractive mode

```json
{
  "url": "https://example.org/guide",
  "metadata": {"title": "Setup Guide", "description": null, "canonicalUrl": null, "language": "en"},
  "content": {"text": "Run setup before starting the service.", "markdown": ""},
  "summarizer": "extractive"
}
```

### answer-analysis

Accept deterministic IDs and provider/model selector objects in the same
ordered `sentiment.analyzers` array. Use that union for `sentiment.primary`.
Discovery exposes the selector for each enabled analyzer. Preserve existing
result identifiers for correlating verdicts and usage. Keep the
`det:lexicon` default, explicit `[]`, language and primary selection rules,
and ADR 0040's current-deployment eligibility check before result lookup.

`POST /v1/answer-analyses`

```json
{
  "text": "Acme is better than Beta.",
  "brands": [
    {"key": "acme", "kind": "primary", "name": "Acme", "aliases": [], "domains": []},
    {"key": "beta", "kind": "competitor", "name": "Beta", "aliases": [], "domains": []}
  ],
  "sentiment": {
    "language": "en",
    "analyzers": ["det:lexicon", {"provider": "openai", "model": "gpt-6-luna"}],
    "primary": {"provider": "openai", "model": "gpt-6-luna"},
    "onUnsupportedLanguage": "fallback"
  }
}
```

### Validation and cache identity

- Return HTTP 400 `validation_failed` for malformed selections, including missing
  required pair fields, wrong types, empty IDs, the old qualified LLM string
  in the analyzer list, or a pair supplied in extractive mode. Keep
  `uniqueItems` on analyzers. Repeated deterministic IDs and repeated exact
  pairs are duplicates even when JSON object property order differs.
- For answer-analysis, an explicit primary outside the requested list returns
  HTTP 422 `invalid_primary`, comparing selector values. Well-formed unlisted
  or disabled selectors return HTTP 422 `unsupported_analyzer` with the
  offending analyzer index. A stale or unavailable catalog cannot authorize a
  result-cache hit. A confirmed disabled analyzer still fails when its result
  was cached while enabled. Keep the existing semantic error order after schema
  validation: `duplicate_brand_key`, `invalid_primary`, `unsupported_analyzer`,
  then `unsupported_language`.
- For engine-query and LLM page descriptions, an unsupported pair returns
  HTTP 422 `unsupported_model` identifying the selection. For engine-query,
  search on a pair without search capability returns HTTP 422
  `unsupported_web_search` identifying `/webSearch`. Validate eligibility and
  supported search before cache lookup and provider work. Existing provider
  model checks and metering remain tool-local.
- Apply the new schema's defaults before hashing. Include the effective
  `provider` and `model` once per selector in canonical input, in their request
  fields. Keep analyzer arrays ordered. Engine-query keys use explicit
  `webSearch` and the pair directly, replacing `engineModel` and
  `webSearchDefaults`. Page-entry keys retain the original `/url` through
  `rawUrlKeyInputs` in both modes.

Offline acceptance cases use only the new contracts.

| Tool | Equivalent inputs share a key | Inputs that must stay distinct or fail |
| --- | --- | --- |
| engine-query | Same pair and search value with omitted vs. explicit locale and country defaults | Different allowed pairs or search modes produce different keys. A missing pair or search flag fails schema validation. Unsupported pairs and search-on for text-only pairs fail before lookup. |
| llms-txt-generator | Same explicit pair with omitted vs. explicit LLM summarizer | Different eligible pairs separate. Extractive and LLM modes separate. An extractive request carrying a pair fails validation. URLs such as `https://example.org:443/guide` and `https://example.org/guide` have distinct keys in both modes. |
| answer-analysis | Omitted sentiment, an empty sentiment object, and explicit HTTP defaults share a key. Changing selector object property order preserves identity. | Different pairs, reversed analyzer order, and explicit `[]` stay distinct. Duplicate selectors fail schema validation. An explicit primary outside the list or a disabled analyzer fails before a cached result can be used. |

## Consequences

- Implement the tool contract cutover before or with ADR 0040's caller policy.
  Apply its explicit Luna pin, original URL keying, and analyzer eligibility to
  the new shapes. Skip the intermediate key rules for omitted LLM models and
  ignored extractive model fields. Runtime caller-cache integration follows
  separately.
- The new OpenAPI majors give fresh `specMajor` namespaces. Apply the
  [existing cache version rules](../../packages/contracts/cache/policy.yaml)
  independently. The pair, mode, URL, and ordered selector input changes call
  for keyVersion bumps in the cutover from the current 4, 6, and 4 to 5, 7, and 5,
  respectively. A later eligibility-only change with identical canonical inputs
  and tool outputs needs no additional bump.
- Coordinate the [answer-capture and page-audit worker flows](../services/workers.md#flows)
  and their orchestrator producers and result consumers. Audit
  [AsyncAPI](../../packages/contracts/asyncapi/events.yaml) references in
  `answerCaptureRequested`, `answerCaptureCompleted`, and `PageAuditJob`, and
  [orchestrator OpenAPI](../../packages/contracts/openapi/services/orchestrator.yaml)
  references in tracking sentiment settings, stored answers, and llms.txt
  settings. Keep the tracking engine explicit at those platform boundaries.
  Review affected public and message versions separately under existing rules,
  including [event versioning](../events.md#versioning) for payloads with no
  implemented producer or consumer.
- Move the three tools' route and validation benchmark fixtures, cache golden
  vectors, generated clients and bundles, and smoke callers together. These
  include `scripts/smoke-answer-capture.mjs` and the tool-local
  `smoke-engine-query.mjs`, `smoke-describe-page.mjs`, and
  `smoke-analysis.mjs`. Preserve recorded provider responses and verify
  replay through the new request shapes offline.
- The reviewed tree has no implemented worker, gateway, or orchestrator caller
  and revealed no independently deployed caller. Verify out-of-repo deployment
  inventory before cutover. Any independent caller discovered requires a
  separate rollout decision before the in-place change.
- Phase 3 has started and Phase 2 acceptance remains pending. Contracts,
  cache-policy changes, generated files, code, tests, and live calls follow
  separately.

## Alternatives considered

- **Keep the three selector shapes.** Avoids a cutover but keeps implicit
  resolution and distinct encodings in every caller.
- **Run old and new tool APIs during migration.** Supports independent rollout
  but adds a compatibility surface for these pre-release tools.
- **Use one shared runtime catalog.** Simplifies central configuration but
  couples standalone tools to one provider and pricing catalog.
