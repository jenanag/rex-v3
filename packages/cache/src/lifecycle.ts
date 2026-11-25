import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isObject, pointerValue } from "./json.js";
import { deriveCacheKey } from "./key.js";
import type { CacheKeyOptions, CacheKeyResult } from "./key.js";
import { bucketExpiry, findPolicy, seconds } from "./policy.js";
import type { CacheDiagnostic, CachePolicy } from "./policy.js";
import { findOperation } from "./schema.js";

export interface RuntimeCachePolicy extends CachePolicy {
  backend: { maxValueBytes: number; compressAboveBytes: number };
  byReference: readonly string[];
  singleFlight: { enabled: boolean; pollMs: number };
}

export interface CacheClock {
  now(): number;
  /** Resolve after ms, and cancel the scheduled wait when the signal aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface CacheEntry {
  /** JSON-serialized response, prior to any backend compression. */
  value: string;
  cachedAt: number;
  expiresAt: number;
}

export interface CacheLease {
  token: string;
  expiresAt: number;
}

interface PublishOptions {
  ownerToken?: string;
  deadline: number;
  compressAboveBytes: number;
}

export interface CacheBackend {
  read(key: string, signal: AbortSignal): Promise<CacheEntry | undefined>;
  /** Atomically acquire only if no live lock exists. Never install an already expired lease. */
  acquire(
    key: string,
    lease: CacheLease,
    signal: AbortSignal,
  ): Promise<{ acquired: true } | { acquired: false; expiresAt: number }>;
  /** Atomically check the deadline, entry expiry, and any live owner token before writing. */
  publish(
    key: string,
    entry: CacheEntry,
    options: PublishOptions,
    signal: AbortSignal,
  ): Promise<boolean>;
  /** Atomically remove the lock only if this token still owns it. */
  release(key: string, token: string, signal: AbortSignal): Promise<void>;
}

export interface ToolResponse<T> {
  status: number;
  body: T;
}

interface Attempt {
  deadline: number;
  signal: AbortSignal;
}

export interface ArchiveCapture<T> extends Attempt {
  archiveTo: string;
  key: string;
  cachedAt: number;
  response: ToolResponse<T>;
  /** When present, the adapter must verify live ownership atomically with acceptance. */
  lease?: Readonly<CacheLease>;
}

export type CacheMode = "use" | "refresh" | "bypass";

export interface CacheCallOptions<T> extends Omit<CacheKeyOptions, "policy" | "timestamp"> {
  policy: RuntimeCachePolicy;
  backend: CacheBackend;
  clock: CacheClock;
  mode?: CacheMode;
  /** Absolute epoch milliseconds, including time spent waiting for the cache. */
  deadline?: number;
  call(attempt: Attempt): Promise<ToolResponse<T>>;
  archive?(capture: ArchiveCapture<T>): Promise<boolean>;
}

export interface CacheCallResult<T> {
  response: ToolResponse<T>;
  outcome: "hit" | "miss" | "refresh" | "bypass" | "uncacheable";
  cachedAt: number | null;
  /** Available on a hit, a stored result, or an archive-accepted result. */
  key?: string;
  diagnostics: CacheDiagnostic[];
}

export class CacheDeadlineError extends Error {
  constructor(readonly reason: "missing_deadline" | "deadline_exceeded") {
    super(
      reason === "missing_deadline"
        ? "Cache dispatch requires a deadline"
        : "Cache deadline exceeded",
    );
    this.name = "CacheDeadlineError";
  }
}

export class CacheArchiveError extends Error {
  readonly retryable = true;

  constructor() {
    super("The page result has no accepted archive reference");
    this.name = "CacheArchiveError";
  }
}

class BackendFailure extends Error {}

async function runUntil<T>(
  clock: CacheClock,
  deadline: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  if (deadline === Infinity) return work(controller.signal);
  const remaining = deadline - clock.now();
  if (remaining <= 0) throw new CacheDeadlineError("deadline_exceeded");

  const timer = new AbortController();
  const timeout = clock.sleep(remaining, timer.signal).then(() => {
    if (timer.signal.aborted) throw timer.signal.reason;
    const error = new CacheDeadlineError("deadline_exceeded");
    controller.abort(error);
    throw error;
  });
  try {
    const result = await Promise.race([
      timeout,
      (async () => {
        if (clock.now() >= deadline) throw new CacheDeadlineError("deadline_exceeded");
        return work(controller.signal);
      })(),
    ]);
    if (clock.now() >= deadline) throw new CacheDeadlineError("deadline_exceeded");
    return result;
  } finally {
    timer.abort();
  }
}

type CacheableKey = Extract<CacheKeyResult, { status: "cacheable" }>;

function freshResponse<T>(
  entry: CacheEntry | undefined,
  key: CacheableKey,
  now: number,
): ToolResponse<T> | undefined {
  if (!entry || !(now < entry.expiresAt) || !(entry.cachedAt <= now)) return;
  if ("ttlSeconds" in key && now - entry.cachedAt >= key.ttlSeconds * 1000) return;
  try {
    const response = JSON.parse(entry.value) as ToolResponse<T>;
    if (Number.isInteger(response?.status) && response.status >= 200 && response.status < 300)
      return response;
  } catch {
    // Treat unreadable cache data as a miss.
  }
}

function shouldSkip(rule: { pointer: string; equals: unknown }, body: unknown): boolean {
  function matches(value: unknown, segments: string[]): boolean {
    if (!segments.length) return isDeepStrictEqual(value, rule.equals);
    const [segment, ...rest] = segments;
    if (segment === "*" && (Array.isArray(value) || isObject(value)))
      return Object.values(value).some((item) => matches(item, rest));
    return matches(pointerValue(value, "/" + segment), rest);
  }
  return matches(body, rule.pointer.slice(1).split("/"));
}

export async function callWithCache<T>(options: CacheCallOptions<T>): Promise<CacheCallResult<T>> {
  const { policy, backend, clock, tool, operationId } = options;
  const startedAt = clock.now();
  const limits = findOperation(options.contract, operationId)["x-rex-limits"];
  const maxDuration =
    limits?.maxDuration === undefined ? Infinity : seconds(limits.maxDuration) * 1000;
  if (limits?.maxDuration !== undefined && (!Number.isFinite(maxDuration) || maxDuration <= 0))
    throw new Error("Invalid x-rex-limits.maxDuration");
  if (options.deadline !== undefined && !Number.isFinite(options.deadline))
    throw new Error("Invalid caller deadline");
  const deadline = options.deadline ?? startedAt + maxDuration;
  const operation = findPolicy(policy, tool, operationId)?.operation;
  const byReference = policy.byReference.includes(tool + "." + operationId);
  const requested = options.mode ?? "use";
  const mode = byReference && requested === "bypass" ? "refresh" : requested;

  let key = deriveCacheKey({ ...options, timestamp: startedAt });
  let boundary =
    key.status === "cacheable" && "window" in key ? bucketExpiry(startedAt, key.window) : Infinity;
  const currentBucket = () => {
    const now = clock.now();
    if (now < boundary) return true;
    key = deriveCacheKey({ ...options, timestamp: now });
    boundary =
      key.status === "cacheable" && "window" in key ? bucketExpiry(now, key.window) : Infinity;
    return false;
  };

  async function cacheIO<R>(
    work: (signal: AbortSignal) => Promise<R>,
    until = deadline,
  ): Promise<R> {
    try {
      return await runUntil(clock, until, work);
    } catch (error) {
      if (error instanceof CacheDeadlineError) throw error;
      throw new BackendFailure("Cache backend unavailable", { cause: error });
    }
  }

  function dispatchDeadline(): number {
    const now = clock.now();
    if (!Number.isFinite(deadline)) throw new CacheDeadlineError("missing_deadline");
    if (now >= deadline) throw new CacheDeadlineError("deadline_exceeded");
    return Math.min(deadline, now + maxDuration);
  }

  let owner: { key: string; lease: CacheLease } | undefined;
  async function releaseOwner() {
    const previous = owner;
    owner = undefined;
    if (!previous || clock.now() >= previous.lease.expiresAt) return;
    try {
      await cacheIO(
        (signal) => backend.release(previous.key, previous.lease.token, signal),
        previous.lease.expiresAt,
      );
    } catch {
      // A lost release is recovered by lease expiry.
    }
  }

  async function lookUp(selected: CacheableKey) {
    const entry = await cacheIO((signal) => backend.read(selected.key, signal));
    // A backend round trip may have crossed the current bucket boundary.
    if (!currentBucket()) return;
    const response = freshResponse<T>(entry, selected, clock.now());
    if (response && entry)
      return {
        response,
        outcome: "hit" as const,
        cachedAt: entry.cachedAt,
        key: selected.key,
        diagnostics: selected.diagnostics,
      };
  }

  let backendAvailable = true;
  async function readOrAcquire() {
    try {
      for (;;) {
        currentBucket();
        if (key.status !== "cacheable") return;
        const selected = key;
        const hit = await lookUp(selected);
        if (hit) return hit;
        if (selected !== key || !currentBucket()) continue;
        const expiresAt = dispatchDeadline();
        if (!policy.singleFlight.enabled) return;

        const lease = { token: randomUUID(), expiresAt };
        const lock = await cacheIO((signal) => backend.acquire(selected.key, lease, signal));
        if (!lock.acquired) {
          if (!currentBucket()) continue;
          const now = clock.now();
          const wait = Math.min(policy.singleFlight.pollMs, deadline - now, lock.expiresAt - now);
          if (wait > 0) await clock.sleep(wait);
          continue;
        }

        owner = { key: selected.key, lease };
        // The previous owner can publish and release between our GET and acquire.
        if (currentBucket() && clock.now() < lease.expiresAt) {
          const afterAcquire = await lookUp(selected);
          if (afterAcquire) return afterAcquire;
          if (selected === key && currentBucket() && clock.now() < lease.expiresAt) return;
        }
        await releaseOwner();
      }
    } catch (error) {
      if (!(error instanceof BackendFailure)) throw error;
      await releaseOwner();
      backendAvailable = false;
    }
  }

  try {
    let dispatched;
    do {
      const shouldRead = mode === "use" && backendAvailable;
      if (shouldRead) {
        const hit = await readOrAcquire();
        if (hit) return hit;
      }
      if (owner && owner.lease.expiresAt <= clock.now()) {
        await releaseOwner();
        continue;
      }
      const attemptDeadline = owner?.lease.expiresAt ?? dispatchDeadline();
      dispatched = await runUntil(clock, attemptDeadline, async (signal) => {
        // Pin at dispatch. A use miss in an older bucket must recheck the new key.
        if (!currentBucket() && shouldRead && backendAvailable) return;
        const pinned = key;
        const pinnedBoundary = boundary;
        const response = await options.call({ deadline: attemptDeadline, signal });
        return { response, pinned, pinnedBoundary };
      });
      if (!dispatched) await releaseOwner();
    } while (!dispatched);

    const { response, pinned, pinnedBoundary } = dispatched;
    const capturedAt = clock.now();
    const result: CacheCallResult<T> = {
      response,
      outcome: "uncacheable",
      cachedAt: null,
      diagnostics: pinned.diagnostics,
    };
    if (!(response.status >= 200 && response.status < 300)) return result;

    if (operation?.archiveTo || byReference) {
      const archiveTo = operation?.archiveTo;
      const archived =
        pinned.status === "cacheable" &&
        archiveTo !== undefined &&
        (await archiveCapture(
          options,
          {
            archiveTo,
            key: pinned.key,
            cachedAt: capturedAt,
            response,
            ...(owner && { lease: { ...owner.lease } }),
          },
          Math.min(deadline, owner?.lease.expiresAt ?? Infinity),
        ));
      if (!archived && byReference) throw new CacheArchiveError();
      if (!archived) return result;
      if (pinned.status === "cacheable") result.key = pinned.key;
    }

    if (mode === "bypass") return { ...result, outcome: "bypass" };
    if (
      !backendAvailable ||
      pinned.status !== "cacheable" ||
      (operation?.skipWhen && shouldSkip(operation.skipWhen, response.body))
    )
      return result;

    let value: string;
    try {
      value = JSON.stringify({ status: response.status, body: response.body });
    } catch {
      return result;
    }
    if (Buffer.byteLength(value, "utf8") > policy.backend.maxValueBytes) return result;
    const now = clock.now();
    const expiresAt = "ttlSeconds" in pinned ? now + pinned.ttlSeconds * 1000 : pinnedBoundary;
    const storeDeadline = Math.min(deadline, owner?.lease.expiresAt ?? Infinity, expiresAt);
    if (now >= storeDeadline) return result;
    try {
      const stored = await cacheIO(
        (signal) =>
          backend.publish(
            pinned.key,
            { value, cachedAt: capturedAt, expiresAt },
            {
              deadline: storeDeadline,
              ownerToken: owner?.lease.token,
              compressAboveBytes: policy.backend.compressAboveBytes,
            },
            signal,
          ),
        storeDeadline,
      );
      if (stored)
        return { ...result, outcome: mode === "refresh" ? "refresh" : "miss", key: pinned.key };
    } catch {
      // The tool result (and any accepted archive reference) remains usable.
    }
    return result;
  } finally {
    await releaseOwner();
  }
}

async function archiveCapture<T>(
  { archive, clock }: CacheCallOptions<T>,
  capture: Omit<ArchiveCapture<T>, keyof Attempt>,
  deadline: number,
): Promise<boolean> {
  if (!archive) return false;
  try {
    return await runUntil(clock, deadline, (signal) => archive({ ...capture, signal, deadline }));
  } catch {
    return false;
  }
}
