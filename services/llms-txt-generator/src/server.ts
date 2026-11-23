import { readFileSync } from "node:fs";
import { loadConfig } from "./config.js";
import type { ToolSpec } from "./contract.js";
import { startTelemetry } from "./telemetry.js";

const config = loadConfig();
const stopTelemetry = await startTelemetry(config);
const { createApp } = await import("./app.js");
const { createHandlers } = await import("./handlers/index.js");
const spec = JSON.parse(
  readFileSync(new URL("../contract.json", import.meta.url), "utf8"),
) as ToolSpec;
const app = createApp({ spec, config, handlers: createHandlers(config) });
try {
  await app.listen({ host: "0.0.0.0", port: config.PORT });
} catch (error) {
  await app.close();
  await stopTelemetry();
  throw error;
}

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  try {
    await app.close();
  } finally {
    await stopTelemetry();
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(
    signal,
    () =>
      void stop().catch(() => {
        process.exitCode = 1;
      }),
  );
}
