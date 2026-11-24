import { readFileSync } from "node:fs";
import { loadConfig } from "./config.js";
import type { ToolSpec } from "./contract.js";
import { startTelemetry } from "./telemetry.js";

const specFile = new URL("../contract.json", import.meta.url);
const spec = JSON.parse(readFileSync(specFile, "utf8")) as ToolSpec;
const config = loadConfig();
const stopTelemetry = await startTelemetry(config);
const [{ createApp }, { createHandlers }] = await Promise.all([
  import("./app.js"),
  import("./handlers/index.js"),
]);
const app = createApp({ spec, config, handlers: createHandlers(spec, config) });
app.addHook("onClose", async () => stopTelemetry());

let shutdown: Promise<void> | undefined;
function close() {
  return (shutdown ??= app.close());
}

try {
  await app.listen({ host: "0.0.0.0", port: config.PORT });
} catch (error) {
  await close();
  throw error;
}

function stop() {
  void close().catch(() => {
    process.exitCode = 1;
  });
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
