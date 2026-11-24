import { readFileSync } from "node:fs";
import { expect } from "vitest";
import { parse } from "yaml";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { contractRoutes, responseMedia, validators, type ToolSpec } from "../src/contract.js";
import { createHandlers } from "../src/handlers/index.js";

const spec = parse(
  readFileSync(new URL("../contract/openapi.yaml", import.meta.url), "utf8"),
) as ToolSpec;
export const config = loadConfig({ NODE_ENV: "test" });
export const tool = (
  changes: Partial<typeof config> = {},
  call?: Parameters<typeof createHandlers>[1],
) =>
  createApp({
    spec,
    config: { ...config, ...changes },
    handlers: createHandlers(spec, call),
    logs: false,
  });
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

export async function postAnswer(app: ReturnType<typeof tool>, payload: object, status: number) {
  const path = "/v1/engine-answers";
  const response = await app.inject({ method: "POST", url: path, payload });
  expect(response.statusCode).toBe(status);
  const body = response.json();
  checkResponse(
    "POST",
    path,
    status,
    status === 200 ? "application/json" : "application/problem+json",
    body,
  );
  return { body, headers: response.headers };
}
