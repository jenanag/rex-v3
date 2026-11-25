# 0042: Set cache window expiry and single-flight deadlines

- **Status:** Accepted (2026-11-25, accepted by Jay)
- **Date:** 2026-11-25
- **Deciders:** Jay Pascual
- **Amends:** [ADR 0016](0016-cache-first.md) for the single-flight
  guarantee under **Redelivery**.

## Context

The [cache policy](../../packages/contracts/cache/policy.yaml) defines fixed UTC
window keys and TTL-based expiry. The runtime needs a store rule for window
entries and a deadline for single-flight misses. The
[roadmap](../roadmap.md#deferred-decisions) records that some cached operations
have no `x-rex-limits.maxDuration`. An `llmCallTimeout` limits an individual
provider call, and a p99 target describes observed latency. An end-to-end caller
deadline also covers time spent waiting for the cache and another owner.

## Decision

### Window expiry

Expire a window entry at the next UTC hour for `PT1H`, the next UTC midnight
for `P1D`, or the next Monday at **00:00 UTC** for `P7D`. Preserve the existing
key formats, including `p7d-YYYY-MM-DD`, and the policy's TTL-based freshness
and expiry rules.

Pin the key once an outbound call is dispatched. If the call finishes within
its deadline at or after the pinned bucket's boundary, return the result and
skip storage under both the original and current buckets. A result that
finishes before the boundary may be stored only while that bucket remains
open and the existing store rules are satisfied. A waiter that has yet to
dispatch rechecks the current bucket before its next lookup or lock attempt.

### Deadline resolution

Use the caller's absolute deadline when supplied. Otherwise derive the
deadline from the wrapper entry time plus the operation's
`x-rex-limits.maxDuration`, when declared. Waiting and takeover consume the
same budget. When both values exist, cap the owner's lease and outbound
attempt at the lesser of `maxDuration` and the caller's remaining budget.
With only one deadline source, cap both at the remaining budget.

A valid cache hit can be served when neither deadline source exists.
Every outbound dispatch requires a finite deadline with time remaining,
including on a miss, in `refresh` or `bypass` mode, and when falling back
after a Redis failure. Concrete gateway and worker timeout values belong
to caller integration.

### Single-flight takeover

Poll every **500 ms**, shortening a poll delay if the caller deadline or
lease expiry comes sooner. On lease expiry, recheck the cache and require
a new lock before dispatch. Make the ownership-token check atomic with
publication of the result and with release of the lock.

The guarantee is one current lock owner per key. An upstream call from an
expired owner may still finish. Its old token cannot publish a result or
release the successor's lock. This amends the statement in ADR 0016 that
single-flight locks stop concurrent identical misses from calling a tool
twice.

## Consequences

At implementation, add the boundary rule to `storeRules` and deadline and
takeover rules to `singleFlight` in the cache policy. Keep the current
`resolution` TTL rules. The rules preserve the OpenAPI contracts and key versions.
Runtime implementation, tests, Redis integration, and deployments follow
in later work.

### Offline acceptance cases

Use a controlled clock and cache to exercise these cases:

| Case | Expected result |
|---|---|
| For each of `PT1H`, `P1D`, and `P7D`, dispatch before the boundary and attempt a write 1 ms before, exactly at, and 1 ms after the boundary. | The first write expires at the boundary. The other two return the timely result without storing it under either bucket. |
| A waiter starts before Monday 00:00 UTC and wakes at the boundary before dispatching. | Its next lookup or lock attempt uses the new weekly key. Its original deadline still applies. |
| A waiter has 350 ms left and the current lease lasts longer. | Its final wait is at most 350 ms. Once its deadline is reached it stops without dispatching. |
| Two waiters recheck an empty cache after a lease expires while the original outbound call is still running. | One acquires the new lock and dispatches. The other waits within its own deadline. The old owner can neither publish nor release the new lock. |
| Neither a caller deadline nor a `maxDuration` is available. | A valid hit is served. A miss or attempted dispatch through `refresh`, `bypass`, or Redis fallback makes zero outbound calls. |
| A caller enters without an explicit deadline and waits before takeover, or supplies an absolute deadline alongside `maxDuration`. | Takeover uses the time remaining on the original budget. When both values exist, the lease and outbound attempt also respect the operation cap. |

## Alternatives considered

- **Retain entries for a full window after each write.** Old-bucket entries would
  occupy cache memory after lookups move to the next key.
- **Skip single-flight when the operation omits `maxDuration`.** With bounded
  transport this allows direct calls, at the cost of duplicated work on misses.
- **Use a configurable fallback timeout.** One default would have to cover both
  fast discovery and slower analysis. Timeout values can be chosen for each caller
  during integration.
