# schema-generator

- **Kind:** tool ([what that means](../architecture.md#service-map))
- **Phase:** 2
- **Contract:** source [packages/contracts/openapi/services/schema-generator.yaml](../../packages/contracts/openapi/services/schema-generator.yaml); vendored, self-contained copy in [services/schema-generator/contract/](../../services/schema-generator/contract/openapi.yaml) ([ADR 0018](../adr/0018-tool-portability.md))
- **Language:** TypeScript (`language: ts` in vendoring.yaml), per [ADR 0025](../adr/0025-schema-generator-language.md).
- **Portability:** a self-contained project in its language: copy `services/schema-generator/` anywhere, then its install, build, test and `docker build` work with nothing else present; no auth, no cache, no bus inside ([ADR 0018](../adr/0018-tool-portability.md))
- **State:** none (callers cache its results, see below)
- **Bus:** none

## Purpose

Generates schema.org JSON-LD for a page type from structured input or a page's HTML,
and validates JSON-LD given inline or found in HTML. Both operations are public free
tools and take content only: no network
([ADR 0021](../adr/0021-content-extraction.md)).

## JSON-LD behavior

Validation expands an inline object or every HTML JSON-LD block in source order.
Malformed embedded JSON, blocked remote contexts, failed expansion, and HTML
without a JSON-LD block are errors. Unknown Schema.org classes or properties
and nonempty graphs without a typed node are warnings. The response is HTTP 200
with `valid: false` when any error is present. HTML findings locate the script
element by line, and inline findings use JSON Pointers into the request.
Malformed or schema-invalid API requests return HTTP 400.

For HTML generation, the first usable node of the exact requested expanded
type takes priority. Open Graph tags and then ordinary HTML metadata fill
missing values. Titles fill `headline` for Article and `name` for the other
supported types. A supplied `source.pageUrl` sets the output `url` and resolves relative
URL values. Without it, unresolved relative URLs are omitted with a warning.
Generation returns HTTP 422 if the source supplies no usable content fields.
Generated markup includes the shared validation result and an HTML-safe script tag.

Expansion uses the vendored context from [Schema.org release 30.1](https://schema.org/version/30.1/)
through an offline loader. The packaged vocabulary index extracts Schema.org
classes, properties, and URL ranges from the same release. The context and
derived data are attributed to Schema.org and its sponsors under CC BY-SA 3.0.
[Context source](https://schema.org/version/30.1/schemaorgcontext.jsonld) ·
[Vocabulary source](https://schema.org/version/30.1/schemaorg-current-https.jsonld) ·
[Schema.org terms](https://schema.org/docs/terms.html) ·
[CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/).

## Endpoints

<!-- GENERATED:endpoints START (source: packages/contracts/openapi/services/schema-generator.yaml) -->
- `POST /v1/schema-markup`: `generateSchemaMarkup` (public via gateway at `/v1/tools/schema-markup`)
- `POST /v1/schema-markup/validate`: `validateSchemaMarkup` (public via gateway at `/v1/tools/schema-markup/validate`)
- `GET /healthz`, `GET /readyz`: shared probes
<!-- GENERATED:endpoints END -->

## Direct smoke check

Use the Node.js version in the repo's [.nvmrc](../../.nvmrc). From the tool
directory, install dependencies, build, and start the service.

```bash
npm ci
npm run build
npm start
```

When the service is listening, open another terminal in the tool directory and
run the smoke check.

```bash
node scripts/smoke.mjs
```

The script posts an organization fixture to the generation route and sends the
returned JSON-LD to the validation route. It checks both responses and exits
nonzero on failure. It connects to `127.0.0.1:8080` by default. If the service
uses a different port, set the same `PORT` for the script.

## Caching (by callers)

<!-- GENERATED:cache START (source: packages/contracts/cache/policy.yaml) -->
Caller cache policy: [policy.yaml](../../packages/contracts/cache/policy.yaml) ([ADR 0016](../adr/0016-cache-first.md)).

keyVersion `2`. The values below are defaults; scope and freshness can be overridden per environment and per customer (policy.yaml `resolution`).

| Operation | Kept for | Scope | Notes |
| --- | --- | --- | --- |
| `generateSchemaMarkup` | `P30D` | shared |  |
| `validateSchemaMarkup` | `P30D` | shared |  |
<!-- GENERATED:cache END -->

## Limits

**Jay's decision (2026-11-22).** Keep `BODY_LIMIT_BYTES` unset so Fastify uses
the template's default 1 MiB request body limit. The shared `html` input schema
allows up to 250,000 characters on both operations.
[ADR 0020](../adr/0020-fastify-openapi-validation.md#validation-budget),
[ADR 0027](../adr/0027-scale-typescript-validation-budget.md).

The CI benchmark checks both routes at exactly 1,048,576 request bytes. ADR 0027
sets a budget of 5 ms p99 per MiB of the effective request body limit, so the
default limit gives each workload a 5 ms p99 budget.
From the tool folder, run `npm run build && node scripts/benchmark-validation.mjs`.

<!-- GENERATED:limits START (source: x-rex-limits in packages/contracts/openapi/services/schema-generator.yaml) -->
See [the tool's operation limits](../../services/schema-generator/AGENTS.md#limits).
<!-- GENERATED:limits END -->

## Shared schemas

<!-- GENERATED:shared START (source: packages/contracts/openapi/services/schema-generator.yaml + common.yaml) -->
- [`Healthz`](../../packages/contracts/openapi/common.yaml) (pathItems); also used by answer-analysis, citation-extractor, content-auditor, content-extractor, engine-query, gateway, llms-txt-generator, orchestrator, sitemap-extractor.
- [`Readyz`](../../packages/contracts/openapi/common.yaml) (pathItems); also used by answer-analysis, citation-extractor, content-auditor, content-extractor, engine-query, gateway, llms-txt-generator, orchestrator, sitemap-extractor.
- [`BadRequest`](../../packages/contracts/openapi/common.yaml) (responses); also used by answer-analysis, citation-extractor, content-auditor, content-extractor, engine-query, llms-txt-generator, orchestrator, sitemap-extractor.
- [`InternalError`](../../packages/contracts/openapi/common.yaml) (responses); also used by answer-analysis, citation-extractor, content-auditor, content-extractor, engine-query, llms-txt-generator, orchestrator, sitemap-extractor.
- [`UnprocessableContent`](../../packages/contracts/openapi/common.yaml) (responses); also used by answer-analysis, content-auditor, content-extractor, engine-query, llms-txt-generator, orchestrator, sitemap-extractor.
- [`Url`](../../packages/contracts/openapi/common.yaml) (schemas); also used by citation-extractor, content-auditor, content-extractor, llms-txt-generator, orchestrator, sitemap-extractor.
- [`ValidationResult`](../../packages/contracts/openapi/common.yaml) (schemas).
<!-- GENERATED:shared END -->

## Used by

- Gateway public routes (HTML or data pasted by the user); later, worker flows that
  propose fixes from a page's stored extraction (Phase 7).

## Dependencies

- None at run time: no network.
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
- `cheerio`: HTML parsing of the raw page passed in
- `jsonld`: JSON-LD expansion for validation
<!-- GENERATED:deps END -->
