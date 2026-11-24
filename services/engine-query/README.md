# engine-query

Run this TypeScript tool from its own folder with Node.js 26.13.1 and npm.

```bash
npm ci
npm run build
LLM_MODE=mock npm test
npm start
```

```bash
curl -fsS http://localhost:8080/healthz
docker build -t engine-query .
docker run --rm -p 8080:8080 engine-query
```

Request validation is compiled from `contract/openapi.yaml`. Edit the source in
the REx monorepo and re-vendor contract changes there.

<!-- GENERATED:env START -->
| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | development | Runtime environment. |
| `SERVICE_NAME` | engine-query | Service name in logs and probes. |
| `PORT` | 8080 | HTTP listen port. |
| `LOG_LEVEL` | info | Structured log level. |
| `PROBLEM_BASE_URI` | https://problems.rex.invalid | Base URI for problem types. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | OTLP collector. Export is off when unset. |
| `BODY_LIMIT_BYTES` | unset | Optional override of the Fastify request-body limit. |
| `LLM_MODE` | unset | Mock by default in tests, live otherwise. |
| `OPENAI_API_KEY` | unset | OpenAI credential for live or record mode. |
| `ANTHROPIC_API_KEY` | unset | Anthropic credential for live or record mode. |
| `GEMINI_API_KEY` | unset | Gemini credential for live or record mode. |
| `PERPLEXITY_API_KEY` | unset | Perplexity credential for live or record mode. |
| `XAI_API_KEY` | unset | xAI credential for live or record mode. |
<!-- GENERATED:env END -->

Mock mode reads the matching Responses fixture in `test/fixtures/llm/`. Its
identity includes the endpoint and full serialized provider request, including
instructions and search settings. The included response is synthetic and covers
annotations and metering without provider traffic.
