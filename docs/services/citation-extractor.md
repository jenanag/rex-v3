# citation-extractor

- **Kind:** tool ([what that means](../architecture.md#service-map))
- **Phase:** 2
- **Contract:** source [packages/contracts/openapi/services/citation-extractor.yaml](../../packages/contracts/openapi/services/citation-extractor.yaml); vendored, self-contained copy in [services/citation-extractor/contract/](../../services/citation-extractor/contract/openapi.yaml) ([ADR 0018](../adr/0018-tool-portability.md))
- **Language:** TypeScript (`language: ts` in vendoring.yaml), per [ADR 0032](../adr/0032-citation-extractor-language.md), accepted by Jay on 2026-11-24.
- **Portability:** a self-contained project in its language: copy `services/citation-extractor/` anywhere, then its install, build, test and `docker build` work with nothing else present; no auth, no cache, no bus inside ([ADR 0018](../adr/0018-tool-portability.md))
- **State:** none (callers cache its results, see below)
- **Bus:** none

## Purpose

Turns an answer's sources and inline links into normalized citations (URL, domain,
source type) and classifies ownership (`own`, `competitor`, `third_party`) against the
tracked brands' domains. Replaces the v1 citation-tracker; storage and domain
aggregates moved to the orchestrator's `tracking` module.

## Endpoints

<!-- GENERATED:endpoints START (source: packages/contracts/openapi/services/citation-extractor.yaml) -->
- `POST /v1/citation-extractions`: `extractCitations`
- `GET /healthz`, `GET /readyz`: shared probes
<!-- GENERATED:endpoints END -->

## Caching (by callers)

<!-- GENERATED:cache START (source: packages/contracts/cache/policy.yaml) -->
Caller cache policy: [policy.yaml](../../packages/contracts/cache/policy.yaml) ([ADR 0016](../adr/0016-cache-first.md)).

keyVersion `2`. The values below are defaults; scope and freshness can be overridden per environment and per customer (policy.yaml `resolution`).

| Operation | Kept for | Scope | Notes |
| --- | --- | --- | --- |
| `extractCitations` | `P30D` | shared |  |
<!-- GENERATED:cache END -->

### Caller cache acceptance cases

The future caller must validate the original request and check the byte length of
the serialized tool request before cache lookup. When canonicalization cannot
produce a safe key, call the tool with the original input and bypass both lookup
and storage. The citation tool performs its own validation and extraction.

| Case | Expected caller behavior |
| --- | --- |
| A cache entry exists for a source URL of `https://example.test/a`; another request supplies `HTTPS://example.test/a`. | Scheme normalization could give them the same key. Reject the uppercase input with HTTP 400 before the cache can serve the entry. |
| A schema-valid request is exactly 4,194,304 bytes; adding `#x` to a source URL leaves the URL within its schema limit and makes the body 4,194,306 bytes. | Fragment removal could give them the same key. Reject the larger body with HTTP 413 before lookup. |
| The source URL `http:///path` passes the request schema. WHATWG parsing could repair it to `http://path/`, which is a usable citation. | The empty authority makes the original source unusable. Bypass lookup and storage for a request whose key would erase this distinction. Forward the original request and expect HTTP 200 with the unusable source omitted. |
| An out-of-range port prevents canonicalization. | Bypass lookup and storage. Forward the original request and let the tool skip the unusable source. |

## Limits

Jay accepted [ADR 0033](../adr/0033-citation-extractor-body-limit.md) on 2026-11-24.
The scaffold defaults to `BODY_LIMIT_BYTES=4194304` (4 MiB) and retains the
current request schema. `extractCitations` returns the normalized, deduplicated
citations in engine-position then Markdown document order. A schema-valid request
with no usable citations returns HTTP 200 with an empty array.

### Request validation benchmark

From `services/citation-extractor/`, run `npm ci`, `npm run build`, and
`node scripts/benchmark-validation.mjs` with the Node version in the root
`.nvmrc`. The shared tool workflow runs the same benchmark offline and
requires validator-only p99 below 20 ms for each of the four workloads.

The benchmark checks both exact-limit requests through the registered route.
Each reaches the extraction handler and returns HTTP 200 at 4,194,304 bytes.
Adding one byte of JSON whitespace returns HTTP 413.

| Exact-limit workload | Engine sources | Trailing JSON spaces |
|---|---:|---:|
| Long strings with escaped Markdown and long source URLs and titles | 405 | 15,467 |
| Short sources with ASCII Markdown and capped brand fields | 46,000 | 925 |

### Direct smoke check

Build and start the service from its folder using the Node version in `.nvmrc`.
Run `npm ci`, `npm run build`, and `npm start`, then run
`node scripts/smoke-citations.mjs` in another terminal. Set `PORT` for both
commands when using a port other than 8080. The smoke check sends a loopback
request with an engine citation and a Markdown link containing entities.

<!-- GENERATED:limits START (source: x-rex-limits in packages/contracts/openapi/services/citation-extractor.yaml) -->
See [the tool's operation limits](../../services/citation-extractor/AGENTS.md#limits).
<!-- GENERATED:limits END -->

## Shared schemas

<!-- GENERATED:shared START (source: packages/contracts/openapi/services/citation-extractor.yaml + common.yaml) -->
- [`Healthz`](../../packages/contracts/openapi/common.yaml) (pathItems); also used by answer-analysis, content-auditor, content-extractor, engine-query, gateway, llms-txt-generator, orchestrator, schema-generator, sitemap-extractor.
- [`Readyz`](../../packages/contracts/openapi/common.yaml) (pathItems); also used by answer-analysis, content-auditor, content-extractor, engine-query, gateway, llms-txt-generator, orchestrator, schema-generator, sitemap-extractor.
- [`BadRequest`](../../packages/contracts/openapi/common.yaml) (responses); also used by answer-analysis, content-auditor, content-extractor, engine-query, llms-txt-generator, orchestrator, schema-generator, sitemap-extractor.
- [`InternalError`](../../packages/contracts/openapi/common.yaml) (responses); also used by answer-analysis, content-auditor, content-extractor, engine-query, llms-txt-generator, orchestrator, schema-generator, sitemap-extractor.
- [`AnswerSource`](../../packages/contracts/openapi/common.yaml) (schemas); also used by engine-query.
- [`Domain`](../../packages/contracts/openapi/common.yaml) (schemas); also used by orchestrator.
- [`TrackedBrand`](../../packages/contracts/openapi/common.yaml) (schemas); also used by answer-analysis.
- [`Url`](../../packages/contracts/openapi/common.yaml) (schemas); also used by content-auditor, content-extractor, llms-txt-generator, orchestrator, schema-generator, sitemap-extractor.
<!-- GENERATED:shared END -->

## Used by

- Worker flow `answer-capture` (third step).

## Dependencies

- Extraction runs offline. The tool bundles the semicolon-terminated names from
  the [WHATWG named character reference table](https://html.spec.whatwg.org/entities.json)
  retrieved on 2026-11-24. It uses that data for CommonMark references without
  rendering HTML or adding a runtime decoder dependency.
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
- `marked`: Markdown lexer for inline links in answer text
<!-- GENERATED:deps END -->
