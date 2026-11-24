import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { contractRoutes, responseMedia, validators, type ToolSpec } from "../src/contract.js";
import { createHandlers } from "../src/handlers/index.js";
import { loadEngineConfig } from "../src/tool-env.js";

const spec = parse(
  readFileSync(new URL("../contract/openapi.yaml", import.meta.url), "utf8"),
) as ToolSpec;
export const config = { ...loadConfig({ NODE_ENV: "test" }), ...loadEngineConfig({}) };
export function tool(
  changes: Partial<typeof config> = {},
  call?: Parameters<typeof createHandlers>[2],
) {
  const effectiveConfig = { ...config, ...changes };
  return createApp({
    spec,
    config: effectiveConfig,
    handlers: createHandlers(spec, effectiveConfig, call),
    logs: false,
  });
}
const compile = validators(spec, false);

export function checkResponse(
  method: string,
  path: string,
  status: number,
  type: string,
  payload: unknown,
) {
  const route = [...contractRoutes(spec)].find(
    (route) => route.method === method.toLowerCase() && route.path === path,
  );
  const response = route?.op.responses[status] ?? route?.op.responses.default;
  const media = response && responseMedia(spec, response)?.[type];
  if (!media)
    throw new Error("Response is absent from the contract: " + method + " " + path + " " + status);
  const validate = compile(media.schema);
  if (!validate(payload)) throw new Error(JSON.stringify(validate.errors));
}
