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

## Python spike

From this directory, enter `python/` and use uv 0.13.9 and the CPython version in
`python/.python-version`. The [spike workflow](../../.github/workflows/python-validation-spike.yml)
has the same commands and installs from the committed lockfile.

```bash
cd python
uv sync --locked
uv run --frozen --offline datamodel-codegen \
  --input ../../../services/answer-analysis/contract/openapi.yaml \
  --input-file-type openapi --output-model-type pydantic_v2.BaseModel \
  --target-python-version 3.13 --disable-timestamp --formatters builtin \
  --output generated_models.py
uv run --frozen --offline pytest -q
uv run --frozen --offline python benchmark.py
```

The Python spike posts through FastAPI in-process with the same shared fixtures
and benchmark workloads as the TypeScript spike. Its benchmark exits nonzero if a
workload reaches or exceeds 5 ms p99. The experiment's CI uses `--report-only` to
record timing misses as evidence. Contract assertions still fail the job.
The generated model is a type-only import. No model is instantiated to validate
the body.
