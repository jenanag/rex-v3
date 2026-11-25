import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createClient, RESP_TYPES } from "@redis/client";
import { parse } from "yaml";
import { callWithCache, deriveCacheKey, RedisCacheBackend } from "@rex/cache";

const socketPath = process.env.REX_CACHE_TEST_REDIS_SOCKET;
assert.ok(socketPath, "Set REX_CACHE_TEST_REDIS_SOCKET to a disposable Redis 7.4.8 Unix socket");

const load = (path) => parse(readFileSync(new URL("../../../" + path, import.meta.url), "utf8"));
const basePolicy = load("packages/contracts/cache/policy.yaml");
const contract = load("services/engine-query/contract/openapi.yaml");
const signal = new AbortController().signal;
const value = (text) => JSON.stringify({ status: 200, body: { text } });
const clock = { now: Date.now, sleep: (ms, signal) => sleep(ms, undefined, { signal }) };

const raw = createClient({ socket: { path: socketPath, reconnectStrategy: false } });
raw.on("error", () => {});
const makeBackend = (t, options = {}) => {
  const backend = new RedisCacheBackend({
    socketPath,
    ioTimeoutMs: 2000,
    maxValueBytes: basePolicy.backend.maxValueBytes,
    ...options,
  });
  t.after(() => backend.close());
  return backend;
};

before(async () => {
  await raw.connect();
  assert.match(await raw.info("server"), /\bredis_version:7\.4\.8\r?\n/);
});

after(() => {
  if (raw.isOpen) raw.destroy();
});

function entry(text, lifetime = 5000) {
  const cachedAt = Date.now();
  return { value: value(text), cachedAt, expiresAt: cachedAt + lifetime };
}

function setup(backend, options = {}) {
  return {
    policy: structuredClone(basePolicy),
    contract,
    tool: "engine-query",
    operationId: "queryEngine",
    request: { provider: "openai", model: "gpt-6-luna", prompt: randomUUID(), webSearch: true },
    backend,
    clock,
    ...options,
  };
}

const storedExpiry = (key) => raw.sendCommand(["PEXPIRETIME", key]);
const readBinary = (key) =>
  raw.sendCommand(["GET", key], { typeMapping: { [RESP_TYPES.BLOB_STRING]: Buffer } });
const noCall = () => assert.fail("Unexpected tool dispatch");

async function afterTime(timestamp) {
  await sleep(Math.max(0, timestamp - Date.now() + 15));
}

test(
  "fresh hits, refresh and bypass through the lifecycle preserve the absolute window expiry",
  { timeout: 5000 },
  async (t) => {
    const backend = makeBackend(t);
    const options = setup(backend);
    const first = await callWithCache({
      ...options,
      call: async () => ({ status: 200, body: { text: "first" } }),
    });
    assert.equal(first.outcome, "miss");
    const entry = await backend.read(first.key, signal);
    const nextMidnight = Math.floor(entry.cachedAt / 86_400_000) * 86_400_000 + 86_400_000;
    assert.equal(entry.expiresAt, nextMidnight);
    assert.equal(await storedExpiry(first.key), nextMidnight);
    const hit = await callWithCache({ ...options, call: noCall });
    assert.equal(hit.outcome, "hit");
    assert.equal(hit.cachedAt, entry.cachedAt);
    const bypass = await callWithCache({
      ...options,
      mode: "bypass",
      call: async () => ({ status: 200, body: { text: "bypass" } }),
    });
    assert.equal(bypass.outcome, "bypass");
    assert.deepEqual((await callWithCache({ ...options, call: noCall })).response, hit.response);
    const refresh = await callWithCache({
      ...options,
      mode: "refresh",
      call: async () => ({ status: 200, body: { text: "replacement" } }),
    });
    assert.equal(refresh.outcome, "refresh");
    assert.deepEqual(
      (await callWithCache({ ...options, call: noCall })).response,
      refresh.response,
    );

    // Advance the wrapper clock across the real bucket boundary without waiting for midnight.
    const rolled = await callWithCache({
      ...options,
      clock: { ...clock, now: () => nextMidnight },
      call: async () => ({ status: 200, body: { text: "new window" } }),
    });
    assert.equal(rolled.outcome, "miss");
    assert.notEqual(rolled.key, first.key);
    assert.equal(await storedExpiry(rolled.key), nextMidnight + 86_400_000);
  },
);

test(
  "Redis expires a TTL entry at the lifecycle's stored timestamp",
  { timeout: 5000 },
  async (t) => {
    const backend = makeBackend(t);
    const options = setup(backend, { operationId: "listEngines", request: {} });
    options.policy.resolution.limits.minTtl = "PT0.5S";
    options.policy.tools["engine-query"].operations.listEngines.ttl = "PT0.5S";
    const result = await callWithCache({
      ...options,
      deadline: Date.now() + 2000,
      call: async () => ({ status: 200, body: [] }),
    });
    assert.equal(result.outcome, "miss");
    const stored = await backend.read(result.key, signal);
    assert.equal(await storedExpiry(result.key), stored.expiresAt);
    assert.ok(stored.expiresAt >= stored.cachedAt + 500);
    assert.equal((await callWithCache({ ...options, call: noCall })).outcome, "hit");
    await afterTime(stored.expiresAt);
    assert.equal(await storedExpiry(result.key), -2);
    assert.equal(await backend.read(result.key, signal), undefined);
  },
);

test(
  "gzip uses UTF-8 bytes and preserves timestamps; corrupt envelopes are misses",
  { timeout: 5000 },
  async (t) => {
    const backend = makeBackend(t);
    const exact = entry("é".repeat(30));
    const limit = Buffer.byteLength(exact.value);
    for (const [encoded, compressed] of [
      [exact, false],
      [entry("é".repeat(31)), true],
    ]) {
      const key = randomUUID();
      assert.ok(
        await backend.publish(
          key,
          encoded,
          {
            deadline: Date.now() + 1000,
            compressAboveBytes: limit,
          },
          signal,
        ),
      );
      assert.deepEqual(await backend.read(key, signal), encoded);
      assert.equal(await storedExpiry(key), encoded.expiresAt);
      const data = await readBinary(key);
      const end = data.indexOf(10);
      assert.deepEqual(JSON.parse(data.subarray(0, end).toString()), [
        1,
        compressed,
        encoded.cachedAt,
        encoded.expiresAt,
        Buffer.byteLength(encoded.value),
      ]);
      if (compressed) {
        assert.deepEqual([...data.subarray(end + 1, end + 3)], [0x1f, 0x8b]);
        await raw.set(key, data.subarray(0, data.length - 5));
        assert.equal(await backend.read(key, signal), undefined);
      } else {
        assert.equal(data.subarray(end + 1).toString(), encoded.value);
      }
      await raw.set(key, "{corrupt");
      assert.equal(await backend.read(key, signal), undefined);
      await raw.del(key);
      await raw.lPush(key, "wrong type");
      assert.equal(await backend.read(key, signal), undefined);
    }

    const constrained = makeBackend(t, { maxValueBytes: limit - 1 });
    const key = randomUUID();
    assert.equal(
      await constrained.publish(
        key,
        exact,
        {
          deadline: Date.now() + 1000,
          compressAboveBytes: 0,
        },
        signal,
      ),
      false,
    );
    assert.equal(await readBinary(key), null);
  },
);

test(
  "independent Redis connections coalesce use misses through the lifecycle",
  { timeout: 5000 },
  async (t) => {
    const one = makeBackend(t);
    const two = makeBackend(t);
    const options = setup(one);
    let dispatches = 0;
    const call = async () => {
      dispatches++;
      await sleep(100);
      return { status: 200, body: { text: "shared" } };
    };
    const results = await Promise.all([
      callWithCache({ ...options, call }),
      callWithCache({ ...options, backend: two, call }),
    ]);
    assert.equal(dispatches, 1);
    assert.deepEqual(results.map(({ outcome }) => outcome).sort(), ["hit", "miss"]);
    assert.equal(results[0].key, results[1].key);
    assert.deepEqual(results[0].response, results[1].response);
  },
);

test(
  "one live lease covers competing connections; an expired owner cannot publish or release its successor",
  { timeout: 5000 },
  async (t) => {
    const clients = [makeBackend(t), makeBackend(t)];
    const key = randomUUID();
    await Promise.all(clients.map((backend) => backend.read(key, signal)));
    const expiresAt = Date.now() + 600;
    const leases = [
      { token: randomUUID(), expiresAt },
      { token: randomUUID(), expiresAt },
    ];
    const results = await Promise.all(
      clients.map((backend, i) => backend.acquire(key, leases[i], signal)),
    );
    const winnerIndex = results.findIndex(({ acquired }) => acquired);
    assert.notEqual(winnerIndex, -1);
    assert.deepEqual(results[1 - winnerIndex], { acquired: false, expiresAt });
    assert.equal(await storedExpiry(key + ":lock"), expiresAt);

    const owner = clients[winnerIndex];
    const stale = leases[winnerIndex];
    const other = clients[1 - winnerIndex];
    await afterTime(expiresAt);
    const next = { token: randomUUID(), expiresAt: Date.now() + 1500 };
    assert.deepEqual(await other.acquire(key, next, signal), { acquired: true });
    assert.equal(
      await owner.publish(
        key,
        entry("stale"),
        {
          ownerToken: stale.token,
          deadline: next.expiresAt,
          compressAboveBytes: 1024,
        },
        signal,
      ),
      false,
    );
    await owner.release(key, stale.token, signal);
    assert.equal(await raw.get(key + ":lock"), next.token);
    const accepted = entry("replacement");
    assert.ok(
      await other.publish(
        key,
        accepted,
        {
          ownerToken: next.token,
          deadline: next.expiresAt,
          compressAboveBytes: 1024,
        },
        signal,
      ),
    );
    await other.release(key, next.token, signal);
    assert.equal(await raw.get(key + ":lock"), null);
    assert.deepEqual(await owner.read(key, signal), accepted);
  },
);

test(
  "server time prevents delayed leases or publications after the supplied deadlines",
  { timeout: 5000 },
  async (t) => {
    const backend = makeBackend(t);
    const key = randomUUID();
    await backend.read(key, signal);
    const expiryKey = randomUUID();
    const deadline = Date.now() + 75;
    const expiredEntry = entry("already expired", 75);
    await raw.sendCommand(["CLIENT", "PAUSE", "200", "ALL"]);
    const [lease, published, expired] = await Promise.all([
      backend.acquire(key, { token: randomUUID(), expiresAt: deadline }, signal),
      backend.publish(key, entry("late"), { deadline, compressAboveBytes: 1024 }, signal),
      backend.publish(
        expiryKey,
        expiredEntry,
        {
          deadline: deadline + 1000,
          compressAboveBytes: 1024,
        },
        signal,
      ),
    ]);
    assert.equal(lease.acquired, false);
    assert.ok(lease.expiresAt >= deadline);
    assert.equal(published, false);
    assert.equal(expired, false);
    assert.equal(await raw.get(key + ":lock"), null);
    assert.equal(await raw.get(key), null);
    assert.equal(await raw.get(expiryKey), null);
  },
);

test(
  "an aborted read rejects and backend timeout bounds deadline-free I/O and lifecycle fallback",
  { timeout: 5000 },
  async (t) => {
    const backend = makeBackend(t, { ioTimeoutMs: 90 });
    const options = setup(backend);
    const key = deriveCacheKey({ ...options, timestamp: Date.now() }).key;
    await backend.read(key, signal);
    const controller = new AbortController();
    await raw.sendCommand(["CLIENT", "PAUSE", "650", "ALL"]);
    const started = Date.now();
    const explicitAbort = backend.read(key, controller.signal);
    const expectedAbort = assert.rejects(explicitAbort, { name: "AbortError" });
    await sleep(20);
    controller.abort();
    await expectedAbort;
    const beforeFallback = Date.now();
    const noDeadline = backend.read(key, signal);
    const assertBounded = assert.rejects(noDeadline, { name: "TimeoutError" });
    const result = await callWithCache({
      ...options,
      call: async () => ({ status: 200, body: { text: "fallback" } }),
    });
    await assertBounded;
    assert.equal(result.outcome, "uncacheable");
    assert.deepEqual(result.response.body, { text: "fallback" });
    assert.ok(Date.now() - beforeFallback < 450);
    assert.ok(Date.now() - started < 650);
    await raw.ping();
    assert.equal(await raw.get(key), null);
  },
);

test("a timed-out write never reappears on a fresh connection", { timeout: 5000 }, async (t) => {
  const backend = makeBackend(t, { ioTimeoutMs: 90 });
  const key = randomUUID();
  await backend.read(key, signal);
  await raw.sendCommand(["CLIENT", "PAUSE", "300", "ALL"]);
  await assert.rejects(
    backend.publish(
      key,
      entry("must not replay"),
      {
        deadline: Date.now() + 2000,
        compressAboveBytes: 1024,
      },
      signal,
    ),
    { name: "TimeoutError" },
  );
  await raw.ping();
  assert.equal(await backend.read(key, signal), undefined);
  const replacement = entry("later call");
  assert.ok(
    await backend.publish(
      key,
      replacement,
      {
        deadline: Date.now() + 1000,
        compressAboveBytes: 1024,
      },
      signal,
    ),
  );
  assert.deepEqual(await backend.read(key, signal), replacement);
});

test(
  "a disconnected backend falls back to one bounded tool attempt",
  { timeout: 5000 },
  async (t) => {
    const backend = makeBackend(t, { socketPath: socketPath + ".absent", ioTimeoutMs: 90 });
    const deadline = Date.now() + 2000;
    let attempts = 0;
    const result = await callWithCache({
      ...setup(backend),
      deadline,
      call: async (attempt) => {
        attempts++;
        assert.equal(attempt.deadline, deadline);
        return { status: 200, body: [] };
      },
    });
    assert.equal(attempts, 1);
    assert.equal(result.outcome, "uncacheable");
  },
);
