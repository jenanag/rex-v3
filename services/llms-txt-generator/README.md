# llms-txt-generator

Run this TypeScript tool from its own folder with Node.js 26.13.1 and npm.

```bash
npm ci
npm run build
LLM_MODE=mock npm test
npm start
```

```bash
curl -fsS http://localhost:8080/healthz
docker build -t llms-txt-generator .
docker run --rm -p 8080:8080 llms-txt-generator
```

Request validation is compiled from `contract/openapi.yaml`. Edit the source in
the REx monorepo and re-vendor contract changes there.

<!-- GENERATED:env START -->
| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | development | Runtime environment. |
| `SERVICE_NAME` | llms-txt-generator | Service name in logs and probes. |
| `PORT` | 8080 | HTTP listen port. |
| `LOG_LEVEL` | info | Structured log level. |
| `PROBLEM_BASE_URI` | https://problems.rex.invalid | Base URI for problem types. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | OTLP collector. Export is off when unset. |
| `LLMS_TXT_GENERATOR_DEFAULT_MODEL` | openai/gpt-6-luna | Default priced model for LLM-assisted page descriptions. |
| `BODY_LIMIT_BYTES` | 12582912 | Fastify request body limit in bytes for all routes (ADR 0029). |
| `LLM_MODE` | unset | Mock by default in tests, live otherwise. |
| `OPENAI_API_KEY` | unset | OpenAI credential for live or record mode. |
| `ANTHROPIC_API_KEY` | unset | Anthropic credential for live or record mode. |
| `GEMINI_API_KEY` | unset | Gemini credential for live or record mode. |
| `PERPLEXITY_API_KEY` | unset | Perplexity credential for live or record mode. |
| `XAI_API_KEY` | unset | xAI credential for live or record mode. |
<!-- GENERATED:env END -->

Mock mode reads the JSON completion in `test/fixtures/llm/` for the request's
`provider`, `model`, `operation`, `prompt`, `maxOutputTokens`, and optional `reasoningEffort`.
Record mode writes a fixture and uses the configured provider credentials.
The `summarize_page` fixture records a GPT-6 Luna completion and token counts for a synthetic
page. Run `node scripts/smoke-describe-page.mjs` after the build to check both page-entry
modes over loopback in mock mode and replay the recorded description and usage.
