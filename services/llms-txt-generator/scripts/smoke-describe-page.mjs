import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const reservation = createServer().listen(0, "127.0.0.1");
await once(reservation, "listening");
const { port } = reservation.address();
await new Promise((resolve, reject) =>
  reservation.close((error) => (error ? reject(error) : resolve())),
);

const service = spawn(process.execPath, ["dist/src/server.js"], {
  cwd: fileURLToPath(new URL("../", import.meta.url)),
  env: { NODE_ENV: "test", LLM_MODE: "mock", PORT: String(port), LOG_LEVEL: "warn" },
  stdio: ["ignore", "inherit", "inherit"],
});
const stopped = once(service, "exit");
const base = "http://127.0.0.1:" + port;

try {
  const readiness = AbortSignal.timeout(10_000);
  while (true) {
    assert.equal(service.exitCode, null, "Standalone mock service exited before becoming ready");
    readiness.throwIfAborted();
    const response = await fetch(base + "/readyz", { signal: readiness }).catch(() => null);
    if (response?.ok) {
      await response.body?.cancel();
      break;
    }
    await response?.body?.cancel();
    await delay(50, undefined, { signal: readiness });
  }

  const request = {
    url: "https://example.org/guide",
    metadata: { title: "Setup Guide", description: null, canonicalUrl: null, language: "en" },
    content: { text: "Run setup before starting the service.", markdown: "" },
  };
  for (const [mode, payload, description, usage] of [
    ["extractive", { ...request, summarizer: "extractive" }, request.content.text, []],
    [
      "default LLM",
      request,
      "Run setup before starting the service.",
      [
        {
          provider: "openai",
          model: "gpt-6-luna",
          operation: "summarize_page",
          inputTokens: 81,
          outputTokens: 14,
          costMicrosUsd: 15,
        },
      ],
    ],
  ]) {
    const response = await fetch(base + "/v1/llms-txt/page-entries", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(response.status, 200, mode);
    assert.deepEqual(await response.json(), {
      entry: { url: request.url, title: request.metadata.title, description },
      usage,
    });
    process.stdout.write(mode + " smoke passed (HTTP 200)\n");
  }
} finally {
  service.kill();
  await stopped;
}
