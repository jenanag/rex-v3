# citation-extractor

Run this TypeScript tool from its own folder with Node.js 26.13.1 and npm.

```bash
npm ci
npm run build
LLM_MODE=mock npm test
npm start
```

```bash
curl -fsS http://localhost:8080/healthz
docker build -t citation-extractor .
docker run --rm -p 8080:8080 citation-extractor
```

Request validation is compiled from `contract/openapi.yaml`. Edit the source in
the REx monorepo and re-vendor contract changes there.

<!-- GENERATED:env START -->
| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | development | Runtime environment. |
| `SERVICE_NAME` | citation-extractor | Service name in logs and probes. |
| `PORT` | 8080 | HTTP listen port. |
| `BODY_LIMIT_BYTES` | 4194304 | Tool-wide Fastify request body limit in bytes (ADR 0033). |
| `LOG_LEVEL` | info | Structured log level. |
| `PROBLEM_BASE_URI` | https://problems.rex.invalid | Base URI for problem types. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | OTLP collector. Export is off when unset. |
<!-- GENERATED:env END -->
