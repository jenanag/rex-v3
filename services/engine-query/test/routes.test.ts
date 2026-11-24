import { expect, test } from "vitest";
import { checkResponse, tool } from "./support.js";

test("registered engine operations return the scaffold Problem for valid requests", async () => {
  const app = tool();
  try {
    const list = await app.inject({ method: "GET", url: "/v1/engines" });
    expect(list.statusCode).toBe(501);
    expect(list.json()).toMatchObject({ code: "not_implemented" });
    checkResponse("GET", "/v1/engines", 501, "application/problem+json", list.json());

    const path = "/v1/engine-answers";
    const query = await app.inject({
      method: "POST",
      url: path,
      payload: { engine: "chatgpt", prompt: "What is REx?" },
    });
    expect(query.statusCode).toBe(501);
    expect(query.json()).toMatchObject({ code: "not_implemented" });
    checkResponse("POST", path, 501, "application/problem+json", query.json());

    const invalid = await app.inject({ method: "POST", url: path, payload: { engine: "chatgpt" } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({
      code: "validation_failed",
      errors: [{ pointer: "/prompt" }],
    });
    checkResponse("POST", path, 400, "application/problem+json", invalid.json());
  } finally {
    await app.close();
  }
});
