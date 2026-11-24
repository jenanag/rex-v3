# answer-analysis

- **Kind:** tool ([what that means](../architecture.md#service-map))
- **Phase:** 2
- **Contract:** source [packages/contracts/openapi/services/answer-analysis.yaml](../../packages/contracts/openapi/services/answer-analysis.yaml); vendored, self-contained copy in [services/answer-analysis/contract/](../../services/answer-analysis/contract/openapi.yaml) ([ADR 0018](../adr/0018-tool-portability.md))
- **Language:** TypeScript (`language: ts` in vendoring.yaml), per [ADR 0035](../adr/0035-answer-analysis-language.md), accepted by Jay on 2026-11-24. The TypeScript scaffold provides both operations as HTTP 501 stubs.
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
  each brand's first mention among the tracked brands.
- **Sentiment:** up to 5 analyzers per call, side by side:
  - deterministic: `det:lexicon` (sentiment lexicon with negation and intensifier
    rules, scored over the sentences around each mention) and `det:rules` (comparative
    and recommendation patterns such as "better than", "avoid", "top pick");
  - LLM: `llm:<provider>/<model>`, one batched call per analyzer for all mentions.
- Each mention returns every analyzer's label, score and short rationale, plus an
  agreement summary; the `primary` analyzer fills `sentiment` and `sentimentScore`.
- Deterministic analyzers report `unsupported` for languages they do not cover;
  `listAnalyzers` publishes the current set and languages.

## Languages and the lexicon registry

- **Today:** English (`en`) only for `det:lexicon` and `det:rules`; LLM analyzers accept
  any language (`*`).
- **Language in and out:** `sentiment.language` (BCP 47, common.yaml `LanguageTag`)
  or, when omitted, deterministic detection from the text; the response reports
  `language` and `languageSource`. Matching uses the primary subtag (`en-GB` uses the
  `en` pack).
- **Registry:** deterministic analyzers resolve a lexicon pack by primary subtag from
  an in-process registry built at startup from the tool's `lexicons/<subtag>/`
  folders. A pack holds word and phrase scores, negators, intensifiers, the
  `det:rules` patterns and a pack version. Nothing outside the tool knows about packs;
  `listAnalyzers` reports their languages.
- **Unsupported language:** per request `onUnsupportedLanguage`: `fallback` (default)
  marks the analyzer `unsupported` and promotes the next requested analyzer that
  supports the language to primary (`primaryFallback: true`); `error` answers 422
  `unsupported_language`. The orchestrator sets it from the prompt run's options.
- **Adding a language:**
  1. Add `lexicons/<subtag>/` with the pack files and its version.
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

keyVersion `1`. The values below are defaults; scope and freshness can be overridden per environment and per customer (policy.yaml `resolution`).

| Operation | Kept for | Scope | Notes |
| --- | --- | --- | --- |
| `listAnalyzers` | `PT5M` | shared |  |
| `analyzeAnswer` | `P30D` | shared | skip when `/analyzers/*/status` = `failed` |
<!-- GENERATED:cache END -->

## Limits

<!-- GENERATED:limits START (source: x-rex-limits in packages/contracts/openapi/services/answer-analysis.yaml) -->
See [the tool's operation limits](../../services/answer-analysis/AGENTS.md#limits).
<!-- GENERATED:limits END -->

Jay accepted [ADR 0036](../adr/0036-answer-analysis-body-limit.md) on 2026-11-24.
Normal startup defaults to `BODY_LIMIT_BYTES=3145728` (3 MiB). The request
validation benchmark checks HTTP 501 at the exact ceiling and HTTP 413 one byte
above it for the padded declared fields and nested brand data fixtures. CI
enforces a strict validator-only p99 below 15 ms for each of the five workloads.
After building, run `node scripts/benchmark-validation.mjs` from the tool folder.

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

- A failed LLM analyzer is reported with `status: failed` and the response is not
  cached; if the primary analyzer fails the call answers 503 and the worker retries.
- Brand matching itself (names and aliases) is language independent and runs for every
  language.
