# @rex/cache

The caller cache for workers and the gateway implements
[the cache policy](../contracts/cache/policy.yaml) under [ADR 0016](../../docs/adr/0016-cache-first.md)
and [ADR 0019](../../docs/adr/0019-internal-packages.md). Its call lifecycle follows
[ADR 0042](../../docs/adr/0042-cache-window-expiry-and-single-flight-deadlines.md).

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
the original request. See the policy for canonical input and key format.

A cacheable result contains the key, canonical UTF-8 bytes, effective scope
and TTL in seconds or window, and override diagnostics. Invalid override fields
fall through to the next layer for that field. Out-of-range TTLs clamp to the
policy limits. Windows outside the allowed set produce a diagnostic and fall
through. An unsafe key input or tenant request without an organization ID returns
`uncacheable`. Keep canonical bytes within the caller because they can contain
request content.

`callWithCache` extends these inputs with an injected clock, cache backend, tool
callback, and optional archive callback. The clock and backend agree on epoch
milliseconds. The tool callback receives an absolute deadline and abort signal.
Callers supply the archive callback for operations that require one. It returns
true only after the archive accepts the capture under the supplied key.
The result's optional key identifies a cache entry or an accepted archive
capture. By-reference archive failures throw a retryable `CacheArchiveError`.

The backend owns transport timeouts and compression. The wrapper checks the
uncompressed serialized response size before publication. A backend must
atomically honor the lease token and write deadline, and bound its own read
when no caller deadline is available. Redis, caller integration, and publishing
remain deferred.

From the repo root on the Node version in `.nvmrc` run:

```sh
npm ci --prefix packages/cache
npm run build --prefix packages/cache
npm test --prefix packages/cache
```
