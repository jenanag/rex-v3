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
For a lock-owned call, the callback receives the lease token and expiry in
`lease`, and its deadline and abort signal are bounded by that lease. The
archive adapter must verify that the token still owns an unexpired lease
atomically with accepting a write to the shared archive key. Cancellation
alone cannot prevent a late callback from writing. The data-aggregator adapter
and its wire contract remain deferred.
The result's optional key identifies a cache entry or an accepted archive
capture. By-reference archive failures throw a retryable `CacheArchiveError`.

The wrapper checks the uncompressed serialized response size before publication.
`RedisCacheBackend` uses a Redis URL or Unix socket and requires an explicit I/O
timeout and the policy's uncompressed size limit. It stores the response and its
timestamps together with the supplied absolute expiry. The backend's I/O limit
applies even without a caller deadline. A timed-out operation awaiting a Redis
reply retires its connection. Subsequent calls can connect again without
replaying pending commands. Call `close()` when disposing of the backend.
Caller integration, deployment, and publishing remain deferred.

From the repo root on the Node version in `.nvmrc` run:

```sh
npm ci --prefix packages/cache
npm run build --prefix packages/cache
npm test --prefix packages/cache
```

For integration tests, start a disposable Redis 7.4.8 with TCP disabled and a
private Unix socket. Use a fresh directory and stop that Redis process when the
tests finish. In separate shells from the repo root, run:

```sh
redis-server --port 0 --unixsocket /path/to/fixture/redis.sock --unixsocketperm 600 \
  --save "" --appendonly no
REX_CACHE_TEST_REDIS_SOCKET=/path/to/fixture/redis.sock npm run test:redis --prefix packages/cache
```

## First release

The initial [Changeset](../../.changeset/cache-first-release.md) proposes
`@rex/cache@0.1.0`. From the repo root, after installing root and cache
dependencies, run `npm run test:cache-release` on Node 26.13.1. The check uses a
disposable checkout of the current commit. While the package is at `0.0.0`, it
requires the initial Changeset, verifies that only `@rex/cache@0.1.0` is planned,
and generates the version and changelog in that checkout. After versioning, it
uses the committed package version and matching changelog entry.

Both paths build and inspect the tarball, then install it in a separate consumer
to verify its JavaScript exports and TypeScript declarations. The source
manifest stays private while release preparation is in review.

### GitHub Packages decision

Read-only GitHub checks on 2026-11-25 confirmed that `jenanag/rex-v3` is public and
`rex` is a separate personal account. The available credential identifies as
`jenanag` and has source repository access. Package lookup returned 404 and the
package list required `read:packages`. These checks leave control of `@rex`,
package availability, and intended consumer access unverified.

GitHub's npm registry uses the owner account for the package scope. GitHub
Packages supports private package permissions independent of repository
visibility. Repository permission inheritance or an Actions grant on a public
repository can expose a private package to forks. Keep the future package
private with explicit grants to trusted consumers and verify the build
repository can use those grants before relying on its workflow token.
[GitHub npm registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry)
and [package access controls](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility).

Before publication, Jay must confirm an authorized publisher under `rex` and
approve where the gateway and worker builds will get authenticated read access.
If control of `@rex` cannot be established, publication stays blocked pending a
separate decision amending ADR 0019.

Once approved, a release-only configuration can set
`publishConfig.registry` to `https://npm.pkg.github.com`. Use a GitHub personal
access token (classic) with `write:packages` from an authorized publisher, or a
`GITHUB_TOKEN` only in a trusted release repository with confirmed write access.
For approved consumer builds, configure the scope and inject a read-only
credential at install time:

```ini
@rex:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

Use an authorized classic token with `read:packages` or a workflow token with
an explicit read grant. Pin `"@rex/cache": "0.1.0"` and commit the consumer
lockfile after the release is available. Keep credentials out of the repo and
public PR workflows. The current check uses no GitHub Packages credentials or
registry write permissions.
