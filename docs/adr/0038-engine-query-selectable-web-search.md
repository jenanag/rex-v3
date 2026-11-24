# 0038: Make web search selectable in engine-query

- **Status:** Proposed
- **Date:** 2026-11-25
- **Deciders:** Jay Pascual

## Context

The [current engine-query contract](../../packages/contracts/openapi/services/engine-query.yaml)
requires hosted web search for ChatGPT. The planned Gemini integration will produce
text-only answers for mention and sentiment analysis. Callers need to select whether
an answer requires search, and the caller cache needs to distinguish those modes.
[ADR 0037](0037-engine-query-language.md) remains the accepted TypeScript and
template decision.

## Decision

Add an optional `webSearch: boolean` to the internal `POST /v1/engine-answers`
request. Resolve omission by engine and use the same default at the caller and tool.

| Engine | Omitted | Explicit `false` | Explicit `true` |
|---|---|---|---|
| ChatGPT | Require completed search | Text-only generation | Require completed search |
| Gemini | Text-only generation | Text-only generation | HTTP 422 before any provider call |

Explicit `true` requires completed search on a supported engine. Gemini's planned
integration uses text-only generation without Google Search grounding.
`GET /v1/engines` reports search capability in its `webSearch` field. ChatGPT
reports `true` and Gemini reports `false`. Ungrounded answers return text, metered
usage, and `sources: []`.

Resolve the effective boolean before the caller looks up the request in cache.
Include that value in the key. Omission and the equivalent explicit value share a
key, while search-on and search-off requests for the same prompt and model have
distinct keys. The caller sends the effective setting to the tool, which checks
engine capability. The orchestrator owns future subscription eligibility. Plan
rules and public subscription controls belong to
[Phase 6](../roadmap.md#phase-6-monetization).

## Consequences

- Implementation adds the optional field to the source OpenAPI contract and bumps
  `engine-query.keyVersion` from `2` to `3` in the
  [caller cache policy](../../packages/contracts/cache/policy.yaml). Verify
  omitted/default equivalence and search-mode separation when updating caller key
  handling.
- Ungrounded Gemini answers support mention and sentiment analysis. The
  [Phase 2 completion criterion](../roadmap.md#phase-2-tool-services-one-at-a-time-each-built-and-tested-in-isolation)
  still requires three engines returning sources and usage. Text-only Gemini
  does not count toward that criterion. [Grok PR #34](https://github.com/jenanag/rex-v3/pull/34)
  remains deferred.
- OpenAPI and caller cache policy edits, provider implementation, and live
  verification follow acceptance.

## Alternatives considered

- **Require search for every engine.** This gives a uniform mode but excludes
  text-only Gemini from mention and sentiment workflows.
- **Use fixed behavior per engine.** This keeps requests simpler but prevents a
  caller from selecting text-only ChatGPT or explicitly requiring search.
- **Enforce subscription eligibility inside the tool.** This would make the tool
  depend on billing policy and customer context the orchestrator owns.
