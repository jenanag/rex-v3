# 0017: Deterministic first, LLMs optional and comparable

- **Status:** Accepted (2026-11-22, accepted by Jay)
- **Date:** 2026-11-22
- **Deciders:** Jay Pascual
- **Amended:** 2026-11-22: languages (English only now, designed for more) and the
  lexicon registry.
- **Amended by:** [0041](0041-standardize-tool-provider-model-selection.md), 2026-11-25 (accepted by Jay). Applies only to answer-analysis request selectors. Analyzer result IDs are unchanged.

## Context

Sentiment and similar judgments can be made by LLMs (better nuance, cost, variance,
model drift) or deterministically (lexicons and rules: free, repeatable, explainable,
weaker on nuance). Jay wants LLM-based sentiment, comparable across several LLMs, and a
deterministic method whenever possible.

## Decision

- **answer-analysis:** mention detection, position and occurrences are always
  deterministic (name and alias matching). Sentiment runs any number (up to 5) of
  analyzers in one call: deterministic ones (`det:lexicon`, `det:rules`) and LLM ones
  (`llm:<provider>/<model>`). The response returns each analyzer's label and score per
  mention side by side, plus an agreement summary (majority label, unanimity, score
  spread). A `primary` analyzer feeds the metrics; it defaults to a deterministic one
  when the language is supported. `listAnalyzers` publishes what is available and which
  languages each deterministic analyzer supports (`unsupported` otherwise).
- **General rule for tools:** an operation that uses an LLM offers a deterministic
  method when one is feasible, and lets the caller choose the LLM model so results can
  be compared. Applied now to llms-txt-generator (`summarizer: extractive | llm`);
  content-auditor, citation-extractor and schema-generator are fully deterministic.
- **Languages:** English only for now, designed for more. Requests and responses carry
  a BCP 47 tag (`language`, common.yaml `LanguageTag`; detected when omitted).
  Deterministic analyzers look up a **lexicon registry** keyed by primary language
  subtag; each entry is a lexicon pack (word scores, negators, intensifiers, rule
  patterns, a version). `listAnalyzers` derives its `languages` from the registry, so
  adding a language is adding a pack, not changing the contract. When an analyzer does
  not support the language, the caller's `onUnsupportedLanguage` decides: `fallback`
  (default: report `unsupported`, use the next analyzer that supports it as primary)
  or `error` (422 `unsupported_language`).
- **Extension path:** add a pack under the tool's lexicon registry with a labelled test
  corpus that meets the English accuracy bar, then bump the tool's cache `keyVersion`
  (cached `unsupported` results for that language must not be served). Details in
  [answer-analysis](../services/answer-analysis.md#languages-and-the-lexicon-registry).
- **Caching (ADR 0016):** the cache key covers the whole request, including the analyzer
  list, so changing the analyzers of a project is a cache miss for that answer.

## Consequences

- Metrics work with zero LLM cost; LLMs become an opt-in, comparable signal.
- Customers can see disagreement between models instead of trusting one.
- Running several LLM analyzers multiplies cost; plans limit the number of LLM
  analyzers (Phase 6 entitlements).
- Deterministic analyzers need a lexicon pack per language; non-English text gets LLM
  sentiment (or none) until its pack exists.

## Alternatives considered

- **One fixed LLM for sentiment**: simplest, but opaque, costly and drifts with model
  updates.
- **Deterministic only**: cheap but misses sarcasm, comparisons and hedged language.
- **Separate tool per analyzer**: more services for what is one capability; analyzers
  are a parameter, not a boundary.
