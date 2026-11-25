# @rex/cache

The deterministic core of the caller cache for workers and the gateway implements
[the cache policy](../contracts/cache/policy.yaml) under [ADR 0016](../../docs/adr/0016-cache-first.md)
and [ADR 0019](../../docs/adr/0019-internal-packages.md).

`deriveCacheKey` takes a parsed policy, the caller's bundled OpenAPI 3.1 contract,
the service name, the exact operation ID, and the request body. Pass the timestamp
in epoch milliseconds and supply any tenant ID, variant, override layers, and
policy-declared extra inputs explicitly. Use epoch time from the same caller
decision when deriving keys for a batch that should share a freshness bucket.

Callers validate the request and the serialized byte limit before lookup and
resolve the effective provider/model selections and current deployment eligibility
under [ADR 0040](../../docs/adr/0040-llm-model-and-analyzer-cache-eligibility.md)
and [ADR 0041](../../docs/adr/0041-standardize-tool-provider-model-selection.md).
Pass the validated body with original URL strings so raw URL inputs can be
captured. The package applies schema defaults to the key input without changing
the original request. It uses the policy's eligible arrays and compares their
[RFC 8785 canonical JSON](https://www.rfc-editor.org/rfc/rfc8785) element strings
in UTF-16 order after normalization. URL normalization preserves path and query
spelling, including an empty path and a bare query delimiter.

A cacheable result contains the key, canonical UTF-8 bytes, effective scope
and TTL in seconds or window, and override diagnostics. Invalid override fields
fall through to the next layer for that field. Out-of-range TTLs clamp to the
policy limits. Windows outside the allowed set produce a diagnostic and fall
through. An unsafe key input or tenant request without an organization ID returns
`uncacheable`. Keep canonical bytes within the caller because they can contain
request content. Redis, caller integration, and publishing remain deferred.

From the repo root on the Node version in `.nvmrc` run:

```sh
npm ci --prefix packages/cache
npm run build --prefix packages/cache
npm test --prefix packages/cache
```
