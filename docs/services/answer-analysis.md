# answer-analysis

- **Kind:** tool ([what that means](../architecture.md#service-map))
- **Phase:** 2
- **Contract:** source [packages/contracts/openapi/services/answer-analysis.yaml](../../packages/contracts/openapi/services/answer-analysis.yaml); vendored, self-contained copy in [services/answer-analysis/contract/](../../services/answer-analysis/contract/openapi.yaml) ([ADR 0018](../adr/0018-tool-portability.md))
- **Language:** TypeScript (`language: ts` in vendoring.yaml), per [ADR 0035](../adr/0035-answer-analysis-language.md), accepted by Jay on 2026-11-24.
- **Portability:** a self-contained project in its language: copy `services/answer-analysis/` anywhere, then its install, build, test and `docker build` work with nothing else present; no auth, no cache, no bus inside ([ADR 0018](../adr/0018-tool-portability.md))
- **State:** none (callers cache its results, see below)
- **Bus:** none

## Purpose

Finds tracked brands in an answer text and returns, per brand key, whether and where it
is mentioned and the sentiment of each mention. Aggregation into mention rate, share of
voice and other [metrics](../glossary.md#metric-definitions) happens in the
orchestrator.

## Methods: deterministic first

Per [ADR 0017](../adr/0017-deterministic-first-analysis.md):

- **Mentions, position, occurrences, snippet:** always deterministic (name and alias
  matching, word boundaries, case and diacritics insensitive). Position is the rank of
  each brand's first mention among the tracked brands. The mention core folds case
  and letter diacritics while matching internal spacing and punctuation literally.
  It counts non-overlapping occurrences independently per brand, choosing the longest
  match at a shared start within a brand. Input brand order breaks first-position
  ties. The snippet is a slice of the original text capped at 500 Unicode code points.
- **Sentiment:** up to 5 analyzers per call, side by side:
  - deterministic: `det:lexicon` (sentiment lexicon with negation and intensifier
    rules, scored within the clauses around each mention) and `det:rules` (comparative
    and recommendation patterns such as "better than", "avoid", "top pick");
  - planned: `llm:<provider>/<model>`, one batched call per analyzer for all mentions.
- Each mention returns every analyzer's label, score and short rationale, plus an
  agreement summary; the `primary` analyzer fills `sentiment` and `sentimentScore`.
- Deterministic analyzers report `unsupported` for languages they do not cover;
  `listAnalyzers` publishes the current set and languages.

## Scoring

- `det:lexicon` attributes a cue to the nearest mention within six word tokens in the
  same sentence and clause. Commas, semicolons and contrast markers separate
  clauses. Brand spans cannot serve as cues. Cross-brand ties discard the cue.
  The preceding three word tokens determine negation parity and the nearest
  degree modifier; each resulting cue is clamped to −1 through 1.
- `det:rules` uses explicit brand spans for comparisons and recommendations.
  Comparisons award +0.75 to the preferred brand and −0.75 to the other.
  Recommendations and top picks award +0.75; avoidance awards −0.75.
  Ambiguous slots, self-comparisons and negated patterns are skipped. Overlaps
  resolve leftmost first, then longest at that start, then pack order. The rule
  scorer suppresses patterns with a pack negator in the three preceding words.
- A brand's score is the mean of its distinct source cues, rounded to three
  decimals. A cue-free result scores 0. Scores above 0.25 are positive, scores
  below −0.25 are negative, and both endpoints are neutral. Rationales show the
  first three cues in source order. Agreement compares only `ok` results
  and requires at least two; a tied majority has a null label.

## Languages and the lexicon registry

- **Today:** English (`en`) for `det:lexicon` and `det:rules`. The catalog lists
  these two analyzers, and deterministic calls return `usage: []`.
- **Language in and out:** `sentiment.language` (BCP 47, common.yaml `LanguageTag`)
  or, when omitted, deterministic detection from the text; the response reports
  `language` and `languageSource`. Matching uses the primary subtag (`en-GB` uses the
  `en` pack). Detection ignores words covered by brand matches and tokens without
  letters. It reports English when the remaining letters are Latin and at least
  two distinct English markers account for half or more of the eligible tokens;
  otherwise it reports an undetermined language.
- **Registry:** deterministic analyzers resolve a lexicon pack by primary subtag from
  an in-process registry of the tool's `src/lexicons/<subtag>/` packs. A pack holds word and phrase scores, negators, degree modifiers,
  rule patterns, language markers and a pack version. The English pack is
  project-authored, version 1.0.0, and has no external data. `listAnalyzers` reports
  the registered languages.
- **Unsupported language:** per request `onUnsupportedLanguage`: `fallback` (default)
  marks the analyzer `unsupported` and promotes the next requested analyzer that
  supports the language to primary (`primaryFallback: true`); `error` answers 422
  `unsupported_language`. The orchestrator sets it from the prompt run's options.
- **Adding a language:**
  1. Add `src/lexicons/<subtag>/` with the pack files and its version.
  2. Add a labelled test corpus (at least 300 mentions) and reach the English pack's
     accuracy bar in the tool's tests; tokenization rules for the language (word
     boundaries, diacritics) go in the pack, not in code, unless the script needs a
     new tokenizer.
  3. Bump `keyVersion` of answer-analysis in cache/policy.yaml in the same PR, so
     cached `unsupported` results for that language are not served.
  4. No contract change: `listAnalyzers` shows the new language automatically.

## Endpoints

<!-- GENERATED:endpoints START (source: packages/contracts/openapi/services/answer-analysis.yaml) -->
- `GET /v1/analyzers`: `listAnalyzers`
- `POST /v1/answer-analyses`: `analyzeAnswer`
- `GET /healthz`, `GET /readyz`: shared probes
<!-- GENERATED:endpoints END -->

## Caching (by callers)

<!-- GENERATED:cache START (source: packages/contracts/cache/policy.yaml) -->
Caller cache policy: [policy.yaml](../../packages/contracts/cache/policy.yaml) ([ADR 0016](../adr/0016-cache-first.md)).

keyVersion `3`. The values below are defaults; scope and freshness can be overridden per environment and per customer (policy.yaml `resolution`).

| Operation | Kept for | Scope | Notes |
| --- | --- | --- | --- |
| `listAnalyzers` | `PT5M` | shared |  |
| `analyzeAnswer` | `P30D` | shared | skip when `/analyzers/*/status` = `failed`, preserve array order at `/sentiment/analyzers` |
<!-- GENERATED:cache END -->

## Limits

<!-- GENERATED:limits START (source: x-rex-limits in packages/contracts/openapi/services/answer-analysis.yaml) -->
See [the tool's operation limits](../../services/answer-analysis/AGENTS.md#limits).
<!-- GENERATED:limits END -->

Jay accepted [ADR 0036](../adr/0036-answer-analysis-body-limit.md) on 2026-11-24.
Normal startup defaults to `BODY_LIMIT_BYTES=3145728` (3 MiB). The validator-only
benchmark checks five workloads against a strict p99 below 15 ms. Both exact-limit
fixtures reach the handler and return HTTP 422 `unsupported_analyzer` for their
synthetic IDs; one byte more returns HTTP 413. The benchmark also checks HTTP 200
with advertised IDs. After building, run `node scripts/benchmark-validation.mjs`
from the tool folder.

## Shared schemas

<!-- GENERATED:shared START (source: packages/contracts/openapi/services/answer-analysis.yaml + common.yaml) -->
- [`Healthz`](../../packages/contracts/openapi/common.yaml) (pathItems); also used by citation-extractor, content-auditor, content-extractor, engine-query, gateway, llms-txt-generator, orchestrator, schema-generator, sitemap-extractor.
- [`Readyz`](../../packages/contracts/openapi/common.yaml) (pathItems); also used by citation-extractor, content-auditor, content-extractor, engine-query, gateway, llms-txt-generator, orchestrator, schema-generator, sitemap-extractor.
- [`BadRequest`](../../packages/contracts/openapi/common.yaml) (responses); also used by citation-extractor, content-auditor, content-extractor, engine-query, llms-txt-generator, orchestrator, schema-generator, sitemap-extractor.
- [`InternalError`](../../packages/contracts/openapi/common.yaml) (responses); also used by citation-extractor, content-auditor, content-extractor, engine-query, llms-txt-generator, orchestrator, schema-generator, sitemap-extractor.
- [`ServiceUnavailable`](../../packages/contracts/openapi/common.yaml) (responses); also used by content-auditor, content-extractor, engine-query, llms-txt-generator, sitemap-extractor.
- [`UnprocessableContent`](../../packages/contracts/openapi/common.yaml) (responses); also used by content-auditor, content-extractor, engine-query, llms-txt-generator, orchestrator, schema-generator, sitemap-extractor.
- [`LanguageTag`](../../packages/contracts/openapi/common.yaml) (schemas).
- [`LlmUsageList`](../../packages/contracts/openapi/common.yaml) (schemas); also used by engine-query, llms-txt-generator.
- [`Sentiment`](../../packages/contracts/openapi/common.yaml) (schemas); also used by orchestrator.
- [`TrackedBrand`](../../packages/contracts/openapi/common.yaml) (schemas); also used by citation-extractor.
<!-- GENERATED:shared END -->

## Used by

- Worker flow `answer-capture` (second step).

## Dependencies

- LLM APIs through its LLM adapter, only for `llm:` analyzers; tests use `LLM_MODE=mock`.
<!-- GENERATED:deps START (source: docs/conventions.md#approved-tool-dependencies) -->
- `fastify`: HTTP server
- `@fastify/sensible`: HTTP errors and helpers
- `@fastify/under-pressure`: load shedding, readiness
- `ajv`: JSON Schema 2020-12 validation
- `ajv-formats`: formats for Ajv
- `env-schema`: config from env
- `pino`: logs (Fastify's logger)
- `@opentelemetry/sdk-node`: traces and metrics
- `@opentelemetry/auto-instrumentations-node`: HTTP instrumentation (including Node's built-in fetch used by the LLM SDKs)
- `openai`: LLM SDK (also Perplexity and xAI via `baseURL`) (`--llm`)
- `@anthropic-ai/sdk`: LLM SDK (`--llm`)
- `@google/genai`: LLM SDK (`--llm`)
<!-- GENERATED:deps END -->

## Notes

- When LLM analyzers ship, a failed LLM analyzer is reported with `status: failed` and the response is not
  cached; if the primary analyzer fails the call answers 503 and the worker retries.
- Brand matching itself (names and aliases) is language independent and runs for every
  language.
