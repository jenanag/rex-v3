# OpenAPI request validation spikes

[Roadmap 1.3](../../docs/roadmap.md#13-spikes-request-validation-from-the-vendored-31-spec)
and [ADR 0020](../../docs/adr/0020-fastify-openapi-validation.md).

Use the Node.js version in the root `.nvmrc`. From this directory, run:

```bash
cd ts
npm ci
npm test
npm run bench
```

The tests use Fastify injection and the vendored answer-analysis OpenAPI bundle. The
benchmark times the validator during injection after warmup and reports p50 and p99 in
milliseconds for representative and large requests. It exits with code 1 if the
loader reaches or exceeds 1 ms p99 on either workload. CI passes `--report-only`
to collect timings under ADR 0020's deferred validation budget.

[request-cases.json](request-cases.json) is shared with the future Python and Go spikes.
Each case has a full JSON request body and expected status. Invalid cases include
expected RFC 6901 pointers. A valid case may give the expected `sentiment` after
defaulting. Cases marked `supplement` use a temporary variant of the same request schema
with an optional `spike` object. The variant copies the nullable `score` and `sentiment`
schemas from the vendored `MentionDetail`, and the `propertyNames` and duration
lookahead from the shared contract. See [the schema setup](ts/contract.ts).
