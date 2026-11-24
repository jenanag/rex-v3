import type { FastifyBaseLogger } from "fastify";
import { expect } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { createApp, type Handlers } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { contractRoutes, responseMedia, validators, type ToolSpec } from "../src/contract.js";
import { createHandlers } from "../src/handlers/index.js";

const spec = parse(
  readFileSync(new URL("../contract/openapi.yaml", import.meta.url), "utf8"),
) as ToolSpec;
export const config = loadConfig({ NODE_ENV: "test" });
export const tool = (changes: Partial<typeof config> = {}, operations?: Handlers) => {
  const settings = { ...config, ...changes };
  const handlers =
    operations ??
    createHandlers({
      lunaEnabled: settings.ANSWER_ANALYSIS_LUNA_ENABLED,
      geminiEnabled: settings.ANSWER_ANALYSIS_GEMINI_ENABLED,
    });
  return createApp({ spec, config: settings, handlers, logs: false });
};
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

export async function postAnalysis(
  operations: ReturnType<typeof createHandlers>,
  body: unknown,
  status = 200,
  warn?: FastifyBaseLogger["warn"],
) {
  const path = "/v1/answer-analyses";
  const app = tool({}, operations);
  if (warn)
    app.addHook("preHandler", async (request) => {
      request.log = Object.create(request.log, { warn: { value: warn } });
    });
  try {
    const reply = await app.inject({
      method: "POST",
      url: path,
      payload: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
    expect(reply.statusCode, reply.body).toBe(status);
    const data = reply.json();
    checkResponse(
      "POST",
      path,
      status,
      status === 200 ? "application/json" : "application/problem+json",
      data,
    );
    return { data, retryAfter: reply.headers["retry-after"] };
  } finally {
    await app.close();
  }
}
