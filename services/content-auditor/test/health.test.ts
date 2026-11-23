import { afterEach, expect, test } from "vitest";
import { checkResponse, tool } from "./support.js";

const app = tool();
afterEach(() => app.close());

test("the tool exposes both standard probes", async () => {
  for (const path of ["/healthz", "/readyz"]) {
    const response = await app.inject({
      method: "GET",
      url: path,
      headers: { "x-request-id": "probe-test" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["x-request-id"]).toBe("probe-test");
    checkResponse("GET", path, 200, "application/json", response.json());
  }
});
