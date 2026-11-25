import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import { createClient, ErrorReply, RESP_TYPES } from "@redis/client";
import type { CacheBackend, CacheEntry, CacheLease } from "./lifecycle.js";

const zip = promisify(gzip);
const unzip = promisify(gunzip);
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const binaryReplies = { [RESP_TYPES.BLOB_STRING]: Buffer };
type RedisConnection = Pick<
  ReturnType<typeof createClient>,
  "sendCommand" | "isOpen" | "isReady" | "destroy"
>;

const serverTime = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
`;

const acquireLease =
  serverTime +
  `
local activeExpiry = redis.call('PEXPIRETIME', KEYS[1])
if activeExpiry > now then return {0, activeExpiry} end
if activeExpiry == -1 then return redis.error_reply('Cache lease has no expiry') end
if now >= tonumber(ARGV[2]) or now >= tonumber(ARGV[3]) then return {0, now} end
if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PXAT', ARGV[2]) then
  return {1, tonumber(ARGV[2])}
end
return {0, redis.call('PEXPIRETIME', KEYS[1])}
`;

const publishEntry =
  serverTime +
  `
if now >= tonumber(ARGV[1]) or now >= tonumber(ARGV[2]) then return 0 end
if ARGV[3] ~= '' and
   (redis.call('PEXPIRETIME', KEYS[2]) <= now or redis.call('GET', KEYS[2]) ~= ARGV[3]) then
  return 0
end
redis.call('SET', KEYS[1], ARGV[4], 'PXAT', ARGV[5])
return 1
`;

const releaseLease =
  serverTime +
  `
if now < tonumber(ARGV[2]) and redis.call('PEXPIRETIME', KEYS[1]) > now
   and redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

export type RedisCacheOptions = {
  /** Independent hard limit for a backend operation, including connection setup. */
  ioTimeoutMs: number;
  /** Use the same uncompressed value limit as the lifecycle policy. */
  maxValueBytes: number;
} & ({ url: string; socketPath?: never } | { socketPath: string; url?: never });

function withAbort<T>(promise: Promise<T>, signal: AbortSignal, onAbort?: () => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      reject(signal.reason);
      onAbort?.();
    };
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) reject(signal.reason);
        else resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

function validTimes(cachedAt: unknown, expiresAt: unknown): cachedAt is number {
  return (
    typeof cachedAt === "number" &&
    Number.isFinite(cachedAt) &&
    cachedAt >= 0 &&
    typeof expiresAt === "number" &&
    Number.isFinite(expiresAt) &&
    expiresAt > cachedAt &&
    Math.ceil(expiresAt) <= Number.MAX_SAFE_INTEGER
  );
}

/** Backend for the standalone Redis 7.x cache described in ADR 0016. */
export class RedisCacheBackend implements CacheBackend {
  readonly #options: RedisCacheOptions;
  #client?: RedisConnection;
  #connecting?: Promise<RedisConnection>;
  #closed = false;

  constructor(options: RedisCacheOptions) {
    if (
      !Number.isInteger(options.ioTimeoutMs) ||
      options.ioTimeoutMs < 1 ||
      options.ioTimeoutMs > 2_147_483_647
    )
      throw new RangeError("Redis cache I/O timeout must be a positive timer duration");
    if (!Number.isSafeInteger(options.maxValueBytes) || options.maxValueBytes < 1)
      throw new RangeError("Redis cache value limit must be a positive byte count");
    this.#options = { ...options };
  }

  close(): void {
    this.#closed = true;
    if (this.#client) this.#retire(this.#client);
  }

  async read(key: string, signal: AbortSignal): Promise<CacheEntry | undefined> {
    return this.#run(signal, async (ioSignal) => {
      let data;
      try {
        data = await this.#send<Buffer | null>(["GET", key], ioSignal);
      } catch (error) {
        if (error instanceof ErrorReply && error.message.startsWith("WRONGTYPE ")) return;
        throw error;
      }
      if (data) return this.#decode(data);
    });
  }

  async acquire(key: string, lease: CacheLease, signal: AbortSignal) {
    const expiry = Math.ceil(lease.expiresAt);
    if (!lease.token || !Number.isSafeInteger(expiry) || expiry < 1)
      throw new Error("Invalid Redis cache lease");
    return this.#run(signal, async (ioSignal, deadline) => {
      const [acquired, expiresAt] = await this.#send<[number, number]>(
        [
          "EVAL",
          acquireLease,
          "1",
          key + ":lock",
          lease.token,
          String(expiry),
          String(Math.min(deadline, lease.expiresAt)),
        ],
        ioSignal,
      );
      return acquired ? { acquired: true as const } : { acquired: false as const, expiresAt };
    });
  }

  async publish(
    key: string,
    entry: CacheEntry,
    options: Parameters<CacheBackend["publish"]>[2],
    signal: AbortSignal,
  ): Promise<boolean> {
    return this.#run(signal, async (ioSignal, ioDeadline) => {
      const { cachedAt, expiresAt, value } = entry;
      const { compressAboveBytes, ownerToken } = options;
      if (
        !validTimes(cachedAt, expiresAt) ||
        !Number.isFinite(options.deadline) ||
        !Number.isSafeInteger(compressAboveBytes) ||
        compressAboveBytes < 0 ||
        ownerToken === ""
      )
        throw new Error("Invalid Redis cache publication");
      const bytes = Buffer.byteLength(value, "utf8");
      if (bytes > this.#options.maxValueBytes) return false;
      const raw = Buffer.from(value, "utf8");
      const compressed = bytes > compressAboveBytes;
      const payload = compressed ? await zip(raw) : raw;
      const header = Buffer.from(
        JSON.stringify([1, compressed, cachedAt, expiresAt, bytes]) + "\n",
      );
      const written = await this.#send<number>(
        [
          "EVAL",
          publishEntry,
          "2",
          key,
          key + ":lock",
          String(Math.min(ioDeadline, options.deadline)),
          String(expiresAt),
          ownerToken ?? "",
          Buffer.concat([header, payload]),
          String(Math.ceil(expiresAt)),
        ],
        ioSignal,
      );
      return written === 1;
    });
  }

  async release(key: string, token: string, signal: AbortSignal): Promise<void> {
    await this.#run(signal, (ioSignal, deadline) =>
      this.#send(["EVAL", releaseLease, "1", key + ":lock", token, String(deadline)], ioSignal),
    );
  }

  async #decode(data: Buffer): Promise<CacheEntry | undefined> {
    const newline = data.subarray(0, 128).indexOf(10);
    if (newline < 1) return;
    try {
      const header: unknown = JSON.parse(utf8.decode(data.subarray(0, newline)));
      if (!Array.isArray(header) || header.length !== 5) return;
      const [version, compressed, cachedAt, expiresAt, bytes] = header;
      if (
        version !== 1 ||
        typeof compressed !== "boolean" ||
        !validTimes(cachedAt, expiresAt) ||
        expiresAt <= Date.now() ||
        !Number.isSafeInteger(bytes) ||
        bytes < 0 ||
        bytes > this.#options.maxValueBytes
      )
        return;
      const payload = data.subarray(newline + 1);
      const raw = compressed
        ? await unzip(payload, { maxOutputLength: this.#options.maxValueBytes })
        : payload;
      if (raw.length === bytes && Date.now() < expiresAt)
        return { value: utf8.decode(raw), cachedAt, expiresAt };
    } catch {
      // The next eligible capture can replace a corrupt entry.
    }
  }

  #run<T>(signal: AbortSignal, work: (signal: AbortSignal, deadline: number) => Promise<T>) {
    const { ioTimeoutMs } = this.#options;
    const deadline = Date.now() + ioTimeoutMs;
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(ioTimeoutMs)]);
    bounded.throwIfAborted();
    return withAbort(work(bounded, deadline), bounded);
  }

  async #send<T>(args: (string | Buffer)[], signal: AbortSignal): Promise<T> {
    const client = await withAbort(this.#connect(), signal);
    signal.throwIfAborted();
    const pending = client.sendCommand<T>(args, {
      abortSignal: signal,
      typeMapping: binaryReplies,
    });
    // The pinned client removes a command's abort listener once it writes to the
    // socket. Retire the connection if a reply is still pending when we abort.
    return withAbort(pending, signal, () => this.#retire(client));
  }

  #connect(): Promise<RedisConnection> {
    if (this.#closed) return Promise.reject(new Error("Redis cache backend is closed"));
    if (this.#client?.isReady) return Promise.resolve(this.#client);
    if (this.#connecting) return this.#connecting;

    const { url, socketPath, ioTimeoutMs } = this.#options;
    const socket = { reconnectStrategy: false as const, connectTimeout: ioTimeoutMs };
    const client = createClient({
      url,
      socket: socketPath ? { ...socket, path: socketPath, tls: false } : socket,
      disableOfflineQueue: true,
      disableClientInfo: true,
    });
    // Operation promises surface failures to the lifecycle. The client also
    // emits error events, including disconnects while idle.
    client.on("error", () => {});
    this.#client = client;
    this.#connecting = withAbort(client.connect(), AbortSignal.timeout(ioTimeoutMs), () =>
      this.#retire(client),
    )
      .then(() => client)
      .finally(() => {
        this.#connecting = undefined;
      });
    return this.#connecting;
  }

  #retire(client: RedisConnection): void {
    if (this.#client === client) this.#client = undefined;
    if (client.isOpen) client.destroy();
  }
}
