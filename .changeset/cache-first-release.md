---
"@rex/cache": minor
---

Prepare the first release of the shared caller cache for workers and the gateway.
It includes deterministic key derivation and policy overrides, the call lifecycle
with freshness, deadlines and single-flight ownership, and the Redis 7 backend with
absolute expiry and optional gzip. The archive callback is available for
by-reference captures. The data-aggregator adapter and platform integration follow
separately.
