import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { parse } from "yaml";
import { CacheArchiveError, CacheDeadlineError, callWithCache, deriveCacheKey } from "@rex/cache";

const load = (path) => parse(readFileSync(new URL("../../../" + path, import.meta.url), "utf8"));
const basePolicy = load("packages/contracts/cache/policy.yaml");
const contracts = new Map();
const epoch = Date.parse("2026-11-23T00:00:00Z");
const queryRequest = {
  provider: "openai",
  model: "gpt-6-luna",
  prompt: "Say hello.",
  webSearch: true,
};
const answer = (text) => ({ status: 200, body: { text } });

class ManualClock {
  timers = new Set();

  constructor(time = epoch) {
    this.time = time;
  }

  now() {
    return this.time;
  }

  sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      const cancel = () => {
        this.timers.delete(timer);
        reject(signal.reason);
      };
      const timer = {
        at: this.time + ms,
        fire: () => {
          this.timers.delete(timer);
          signal?.removeEventListener("abort", cancel);
          resolve();
        },
      };
      if (signal?.aborted) return reject(signal.reason);
      signal?.addEventListener("abort", cancel, { once: true });
      this.timers.add(timer);
    });
  }

  async advance(ms) {
    const end = this.time + ms;
    await setImmediate();
    for (;;) {
      const next = Math.min(end, ...[...this.timers].map(({ at }) => at));
      this.time = next;
      for (const timer of [...this.timers]) if (timer.at <= next) timer.fire();
      await setImmediate();
      if (next === end) return;
    }
  }
}

class MemoryBackend {
  values = new Map();
  locks = new Map();
  events = [];
  failures = new Set();

  constructor(clock) {
    this.clock = clock;
  }

  activeLock(key) {
    const lease = this.locks.get(key);
    return lease && lease.expiresAt > this.clock.now() ? lease : undefined;
  }

  async read(key) {
    this.events.push(["read", key]);
    if (this.failures.has("read")) throw new Error("read unavailable");
    const entry = this.values.get(key);
    return entry && entry.expiresAt > this.clock.now() ? entry : undefined;
  }

  async acquire(key, lease) {
    this.events.push(["acquire", key, lease]);
    if (this.failures.has("acquire")) throw new Error("acquire unavailable");
    const current = this.activeLock(key);
    if (current) return { acquired: false, expiresAt: current.expiresAt };
    if (lease.expiresAt <= this.clock.now()) return { acquired: false, expiresAt: lease.expiresAt };
    this.locks.set(key, lease);
    return { acquired: true };
  }

  async publish(key, entry, options) {
    this.events.push(["publish", key, options]);
    if (this.failures.has("publish")) throw new Error("publish unavailable");
    if (this.clock.now() >= Math.min(entry.expiresAt, options.deadline)) return false;
    if (options.ownerToken && this.activeLock(key)?.token !== options.ownerToken) return false;
    this.values.set(key, entry);
    return true;
  }

  async release(key, token) {
    this.events.push(["release", key, token]);
    if (this.failures.has("release")) throw new Error("release unavailable");
    if (this.activeLock(key)?.token === token) this.locks.delete(key);
  }
}

function setup({
  tool = "engine-query",
  operationId = "queryEngine",
  request = queryRequest,
  time = epoch,
} = {}) {
  if (!contracts.has(tool)) {
    contracts.set(
      tool,
      load(
        basePolicy.external[tool]
          ? `packages/contracts/handoff/${tool}.openapi.yaml`
          : `services/${tool}/contract/openapi.yaml`,
      ),
    );
  }
  const clock = new ManualClock(time);
  const backend = new MemoryBackend(clock);
  const options = {
    policy: structuredClone(basePolicy),
    contract: contracts.get(tool),
    clock,
    backend,
    tool,
    operationId,
    request,
  };
  return {
    options,
    clock,
    backend,
    key: (extras = {}, timestamp = clock.now()) =>
      deriveCacheKey({ ...options, ...extras, timestamp }).key,
    invoke: (call, extras) => callWithCache({ ...options, ...extras, call }),
  };
}

function discovery() {
  return setup({ operationId: "listEngines", request: {} });
}

function windowOptions(window) {
  return { customerOverrides: { "*": { window } } };
}

function noCall() {
  assert.fail("Unexpected outbound call");
}

test("use stores once and serves fresh hits; refresh overwrites; bypass leaves the entry alone", async () => {
  const { invoke, backend, options, clock } = setup();
  const first = await invoke(async () => answer("first"));
  assert.equal(first.outcome, "miss");
  assert.equal(first.cachedAt, null);
  assert.equal(backend.values.get(first.key).cachedAt, epoch);
  assert.equal((await invoke(noCall)).outcome, "hit");
  assert.equal((await invoke(noCall)).cachedAt, epoch);

  backend.events.length = 0;
  await clock.advance(20);
  const refreshed = await invoke(async () => answer("refresh"), { mode: "refresh" });
  assert.equal(refreshed.outcome, "refresh");
  assert.deepEqual(
    backend.events.map(([action]) => action),
    ["publish"],
  );
  assert.equal(backend.events[0][2].compressAboveBytes, options.policy.backend.compressAboveBytes);

  backend.events.length = 0;
  const bypassed = await invoke(async () => answer("bypass"), { mode: "bypass" });
  assert.equal(bypassed.outcome, "bypass");
  assert.equal(bypassed.key, undefined);
  assert.deepEqual(backend.events, []);
  assert.deepEqual((await invoke(noCall)).response, answer("refresh"));
});

test("TTL uses each reader's freshness and the storing caller's expiry", async () => {
  const { invoke, clock, backend } = discovery();
  const ttl = (duration) => ({
    deadline: clock.now() + 1000,
    customerOverrides: { "*": { ttl: duration } },
  });
  const first = await invoke(async () => answer("first"), ttl("PT2M"));
  assert.equal(backend.values.get(first.key).expiresAt, epoch + 120_000);
  await clock.advance(60_000);
  assert.equal((await invoke(noCall)).outcome, "hit");
  const replaced = await invoke(async () => answer("shorter"), ttl("PT1M"));
  assert.equal(replaced.outcome, "miss");
  assert.equal(replaced.key, first.key);
  assert.equal(backend.values.get(first.key).expiresAt, epoch + 120_000);
  await clock.advance(60_000);
  assert.equal((await invoke(async () => answer("expired"), ttl("P1D"))).outcome, "miss");
});

test("store exclusions: non-2xx, wildcard skipWhen, uncacheable operation, and UTF-8 size", async () => {
  const { invoke, backend, options } = setup({
    tool: "answer-analysis",
    operationId: "analyzeAnswer",
    request: {
      text: "Acme",
      brands: [{ key: "acme", kind: "primary", name: "Acme", aliases: [], domains: [] }],
    },
  });
  const deadline = epoch + 1000;
  const failed = { status: 200, body: { analyzers: [{ status: "ok" }, { status: "failed" }] } };
  assert.equal((await invoke(async () => failed, { deadline })).outcome, "uncacheable");
  for (const status of [199, 300, 503]) {
    const result = await invoke(async () => ({ status, body: null }), { deadline });
    assert.equal(result.outcome, "uncacheable");
    assert.equal(result.response.status, status);
  }
  const exact = answer("ééé");
  const value = JSON.stringify(exact);
  options.policy.backend.maxValueBytes = Buffer.byteLength(value);
  assert.equal((await invoke(async () => exact, { deadline })).outcome, "miss");
  assert.equal(
    (await invoke(async () => answer("éééé"), { deadline, mode: "refresh" })).outcome,
    "uncacheable",
  );
  assert.deepEqual((await invoke(noCall, { deadline })).response, exact);
  assert.equal(backend.events.filter(([action]) => action === "publish").length, 1);

  options.policy.tools["answer-analysis"].operations.analyzeAnswer.cacheable = false;
  backend.events.length = 0;
  assert.equal((await invoke(async () => exact, { deadline })).outcome, "uncacheable");
  assert.deepEqual(backend.events, []);
});

test("by-reference bypass is refresh and archives before cache write", async () => {
  const { invoke, backend } = setup({
    tool: "content-extractor",
    operationId: "extractContent",
    request: { url: "https://example.org/" },
  });
  const calls = [];
  const result = await invoke(async () => answer("page"), {
    mode: "bypass",
    archive: async ({ key, archiveTo, response, cachedAt, deadline, lease }) => {
      assert.equal(archiveTo, "data-aggregator");
      assert.deepEqual(response, answer("page"));
      assert.equal(cachedAt, epoch);
      assert.equal(deadline, epoch + 30_000);
      assert.equal(lease, undefined);
      assert.deepEqual(backend.events, []);
      calls.push(key);
      return true;
    },
  });
  assert.equal(result.outcome, "refresh");
  assert.deepEqual(calls, [result.key]);
  assert.deepEqual(
    backend.events.map(([action]) => action),
    ["publish"],
  );
  assert.equal((await invoke(noCall)).outcome, "hit");
});

test("oversized or backend-fallback page remains readable by its accepted archive key", async () => {
  const { invoke, backend, options, key } = setup({
    tool: "content-extractor",
    operationId: "extractContent",
    request: { url: "https://example.org/" },
  });
  const archive = new Map();
  const capture = async ({ key, response }) => {
    archive.set(key, response);
    return true;
  };
  options.policy.backend.maxValueBytes = 10;
  const oversized = await invoke(async () => answer("oversized"), { archive: capture });
  assert.equal(oversized.outcome, "uncacheable");
  assert.equal(oversized.key, key());
  assert.deepEqual(archive.get(oversized.key), oversized.response);
  assert.equal(backend.values.size, 0);
  assert.ok(!backend.events.some(([action]) => action === "publish"));

  backend.failures.add("read");
  const fallback = await invoke(async () => answer("fallback"), { archive: capture });
  assert.equal(fallback.outcome, "uncacheable");
  assert.equal(fallback.key, key());
  assert.deepEqual(archive.get(fallback.key), fallback.response);
});

test("a by-reference owner loses its archive deadline at lease expiry and cannot replace the successor", async () => {
  const { invoke, clock, backend, key } = setup({
    tool: "content-extractor",
    operationId: "extractContent",
    request: { url: "https://example.org/" },
  });
  const archive = new Map();
  const holdFirstWrite = Promise.withResolvers();
  const lateDecision = Promise.withResolvers();
  let firstCapture;
  let abortedAt;
  const original = answer("original capture");
  const replacement = answer("successor capture");
  const accept = ({ key, lease, response }) => {
    if (!lease || clock.now() >= lease.expiresAt || backend.activeLock(key)?.token !== lease.token)
      return false;
    archive.set(key, response);
    return true;
  };
  const capture = async (request) => {
    if (request.response === original) {
      firstCapture = request;
      request.signal.addEventListener(
        "abort",
        () => {
          abortedAt = clock.now();
        },
        { once: true },
      );
      // Simulate an adapter that finishes the write attempt after cancellation.
      await holdFirstWrite.promise;
      const accepted = accept(request);
      lateDecision.resolve(accepted);
      return accepted;
    }
    return accept(request);
  };
  const first = assert.rejects(
    invoke(async () => original, { mode: "use", deadline: epoch + 100_000, archive: capture }),
    (error) => error instanceof CacheArchiveError && error.retryable && error.key === undefined,
  );
  await clock.advance(29_999);
  const sharedKey = key();
  assert.deepEqual(firstCapture.lease, backend.activeLock(sharedKey));
  assert.equal(firstCapture.lease.expiresAt, epoch + 30_000);
  assert.equal(firstCapture.deadline, epoch + 30_000);
  assert.equal(firstCapture.signal.aborted, false);

  const successor = invoke(async () => replacement, { mode: "use", archive: capture });
  await clock.advance(1);
  await first;
  assert.equal(abortedAt, epoch + 30_000);
  const result = await successor;
  assert.equal(result.outcome, "miss");
  assert.equal(result.key, sharedKey);

  holdFirstWrite.resolve();
  assert.equal(await lateDecision.promise, false);
  assert.deepEqual(archive.get(result.key), replacement);
  const hit = await invoke(noCall);
  assert.equal(hit.key, result.key);
  assert.deepEqual(hit.response, replacement);
});

test("rejected archive fails a by-reference capture retryably and suppresses other stores", async () => {
  const { invoke, backend, options } = setup({
    tool: "content-extractor",
    operationId: "extractContent",
    request: { url: "https://example.org/" },
  });
  const declined = async () => false;
  await assert.rejects(
    invoke(async () => answer("page"), { archive: declined }),
    (error) => error instanceof CacheArchiveError && error.retryable,
  );
  await assert.rejects(
    invoke(async () => answer("page"), {
      archive: async () => {
        throw Error("archive down");
      },
    }),
    CacheArchiveError,
  );
  await assert.rejects(
    invoke(async () => answer("page")),
    CacheArchiveError,
  );
  assert.ok(!backend.events.some(([action]) => action === "publish"));
  assert.equal(backend.locks.size, 0);

  options.policy.byReference = [];
  const uncacheable = await invoke(async () => answer("page"), { archive: declined });
  assert.equal(uncacheable.outcome, "uncacheable");
  assert.equal(uncacheable.key, undefined);
  let archived = 0;
  assert.equal(
    (
      await invoke(async () => answer("page"), {
        mode: "bypass",
        archive: async () => {
          archived++;
          return true;
        },
      })
    ).outcome,
    "bypass",
  );
  assert.equal(archived, 1);
});

test("backend failures fall back at most once and preserve timely tool results", async () => {
  for (const action of ["read", "acquire", "publish", "release"]) {
    const { invoke, backend } = setup();
    backend.failures.add(action);
    let attempts = 0;
    const result = await invoke(async () => {
      attempts++;
      return answer(action);
    });
    assert.equal(attempts, 1);
    assert.deepEqual(result.response, answer(action));
    assert.equal(result.outcome, action === "release" ? "miss" : "uncacheable");
  }
});

test("without a deadline, a valid hit is served and every dispatch path refuses", async () => {
  const { invoke, backend, key } = discovery();
  const value = JSON.stringify(answer("cached"));
  backend.values.set(key(), { value, cachedAt: epoch, expiresAt: epoch + 500 });
  assert.equal((await invoke(noCall)).outcome, "hit");
  backend.values.clear();
  for (const mode of ["use", "refresh", "bypass"]) {
    await assert.rejects(invoke(noCall, { mode }), { reason: "missing_deadline" });
  }
  backend.failures.add("read");
  await assert.rejects(invoke(noCall), { reason: "missing_deadline" });
  await assert.rejects(invoke(noCall, { deadline: epoch }), { reason: "deadline_exceeded" });
});

for (const window of ["PT1H", "P1D", "P7D"]) {
  test(`${window} publishes before the pinned UTC boundary and skips writes at and after it`, async () => {
    const opts = windowOptions(window);
    for (const offset of [-1, 0, 1]) {
      const { invoke, clock, backend, key } = setup({ time: epoch - 10 });
      const original = key(opts);
      const following = key(opts, epoch);
      assert.notEqual(original, following);
      const pending = invoke(async () => {
        await clock.sleep(10 + offset);
        return answer("timely");
      }, opts);
      await clock.advance(10 + offset);
      const result = await pending;
      assert.deepEqual(result.response, answer("timely"));
      assert.equal(result.outcome, offset < 0 ? "miss" : "uncacheable");
      assert.equal(backend.values.get(original)?.expiresAt, offset < 0 ? epoch : undefined);
      assert.equal(backend.values.has(following), false);
      await clock.advance(1);
      assert.equal(await backend.read(original), undefined);
    }
  });
}

test("a waiter crossing into Monday rechecks and dispatches under the new weekly key", async () => {
  const { invoke, clock, backend, key } = setup({ time: epoch - 500 });
  const opts = windowOptions("P7D");
  const original = key(opts);
  const next = key(opts, epoch);
  const owner = invoke(async () => {
    await clock.sleep(510);
    return answer("Sunday");
  }, opts);
  await clock.advance(0);
  const waiter = invoke(async () => answer("Monday"), opts);
  await clock.advance(500);
  assert.equal((await waiter).key, next);
  assert.equal(backend.values.has(original), false);
  await clock.advance(10);
  assert.equal((await owner).outcome, "uncacheable");
  assert.deepEqual((await invoke(noCall, opts)).response, answer("Monday"));
});

test("a 350 ms waiter expires without dispatch while its owner continues", async () => {
  const { invoke, clock, backend } = setup();
  const owner = invoke(async () => {
    await clock.sleep(1000);
    return answer("owner");
  });
  await clock.advance(0);
  let timedOut = false;
  const waiter = assert
    .rejects(invoke(noCall, { deadline: epoch + 350 }), {
      name: "CacheDeadlineError",
      reason: "deadline_exceeded",
    })
    .then(() => {
      timedOut = true;
    });
  await clock.advance(349);
  assert.equal(timedOut, false);
  assert.equal(backend.locks.size, 1);
  await clock.advance(1);
  await waiter;
  await clock.advance(650);
  assert.equal((await owner).outcome, "miss");
});

test("publication delayed past a boundary cannot store an earlier timely response", async () => {
  const { invoke, clock, backend, key } = setup({ time: epoch - 10 });
  const pinned = key();
  const next = key({}, epoch);
  const publish = backend.publish.bind(backend);
  backend.publish = async (...args) => {
    await clock.sleep(11);
    return publish(...args);
  };
  const pending = invoke(async () => answer("ready before the boundary"));
  await clock.advance(11);
  assert.equal((await pending).outcome, "uncacheable");
  assert.equal(backend.values.has(pinned), false);
  assert.equal(backend.values.has(next), false);
});

test("two waiters race after lease expiry; stale owner cannot publish or release", async () => {
  const { invoke, clock, backend, key } = setup();
  const currentKey = key();
  let oldSignal;
  let oldFinished = false;
  const owner = assert.rejects(
    invoke(
      async ({ signal }) => {
        oldSignal = signal;
        await clock.sleep(1100);
        oldFinished = true;
        return answer("old response");
      },
      { deadline: epoch + 500 },
    ),
    CacheDeadlineError,
  );
  await clock.advance(0);
  const oldLease = backend.locks.get(currentKey);
  const attempts = [];
  const waiters = ["one", "two"].map((id) =>
    invoke(async ({ deadline }) => {
      attempts.push(id);
      assert.equal(deadline, epoch + 120_000);
      await clock.sleep(100);
      return answer("replacement");
    }),
  );
  await clock.advance(500);
  await owner;
  assert.equal(oldSignal.aborted, true);
  assert.equal(oldFinished, false);
  assert.equal(attempts.length, 1);
  const successor = backend.locks.get(currentKey);
  assert.notEqual(successor.token, oldLease.token);
  assert.equal(
    await backend.publish(
      currentKey,
      {
        value: JSON.stringify(answer("stale writer")),
        cachedAt: epoch,
        expiresAt: epoch + 5000,
      },
      { ownerToken: oldLease.token, deadline: epoch + 5000 },
    ),
    false,
  );
  await backend.release(currentKey, oldLease.token);
  assert.equal(backend.activeLock(currentKey).token, successor.token);
  await clock.advance(600);
  const outcomes = await Promise.all(waiters);
  assert.equal(oldFinished, true);
  assert.deepEqual(outcomes.map(({ outcome }) => outcome).sort(), ["hit", "miss"]);
  assert.deepEqual((await invoke(noCall)).response, answer("replacement"));
});

test("caller and operation limits cap the lease and signal even if the transport never returns", async () => {
  const { invoke, clock, backend } = setup();
  let signal;
  const pending = assert.rejects(
    invoke(
      async (attempt) => {
        assert.equal(attempt.deadline, epoch + 120_000);
        signal = attempt.signal;
        return new Promise(() => {});
      },
      { deadline: epoch + 300_000 },
    ),
    CacheDeadlineError,
  );
  await clock.advance(0);
  assert.equal([...backend.locks.values()][0].expiresAt, epoch + 120_000);
  await clock.advance(120_000);
  await pending;
  assert.equal(signal.aborted, true);
  assert.equal(backend.values.size, 0);
});

test("an acquire after a concurrent publication rechecks the cache before dispatch", async () => {
  const { invoke, backend, key } = setup();
  const acquire = backend.acquire.bind(backend);
  backend.acquire = async (...args) => {
    backend.values.set(key(), {
      value: JSON.stringify(answer("other owner")),
      cachedAt: epoch,
      expiresAt: epoch + 1000,
    });
    return acquire(...args);
  };
  const result = await invoke(noCall);
  assert.equal(result.outcome, "hit");
  assert.deepEqual(result.response, answer("other owner"));
  assert.equal(backend.locks.size, 0);
});
