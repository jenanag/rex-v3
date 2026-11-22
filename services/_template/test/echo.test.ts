import { afterEach, expect, test } from "vitest";
import { echo } from "../src/domain/echo.js";
import { checkResponse, tool } from "./support.js";

const apps: ReturnType<typeof tool>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

test("the deterministic domain function returns upper case when requested", () => {
  expect(echo({ text: "Hello", uppercase: true })).toEqual({ text: "HELLO", usage: [] });
});

test("the route applies defaults and produces a contract-valid wire response", async () => {
  const app = tool();
  apps.push(app);
  const response = await app.inject({
    method: "POST",
    url: "/v1/echoes",
    payload: { text: "Hello" },
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ text: "Hello", usage: [] });
  checkResponse("POST", "/v1/echoes", 200, "application/json", response.json());
  expect(() =>
    checkResponse("POST", "/v1/echoes", 200, "application/json", { usage: [] }),
  ).toThrow();
});

test("JSON body validation rejects type coercion and escapes unknown member pointers", async () => {
  const app = tool();
  apps.push(app);
  const response = await app.inject({
    method: "POST",
    url: "/v1/echoes",
    payload: { text: 1, "x/y~z": 1 },
  });
  expect(response.statusCode).toBe(400);
  expect(response.headers["content-type"]).toMatch(/^application\/problem\+json\b/);
  expect(response.json()).toMatchObject({
    code: "validation_failed",
    errors: expect.arrayContaining([
      { pointer: "/text", detail: expect.any(String) },
      { pointer: "/x~1y~0z", detail: expect.any(String) },
    ]),
  });
  checkResponse("POST", "/v1/echoes", 400, "application/problem+json", response.json());
});

test("a tool can override the Fastify body limit", async () => {
  const app = tool({ BODY_LIMIT_BYTES: 8 });
  apps.push(app);
  const response = await app.inject({
    method: "POST",
    url: "/v1/echoes",
    payload: { text: "Hello" },
  });
  expect(response.statusCode).toBe(413);
  expect(response.json()).toMatchObject({ code: "payload_too_large" });
});
