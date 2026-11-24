import { afterAll, expect, test } from "vitest";
import { checkResponse, tool } from "./support.js";

const app = tool();
afterAll(() => app.close());

const path = "/v1/citation-extractions";

test("registers the 4 MiB citation extraction route and validates before calling its stub", async () => {
  expect(app.initialConfig.bodyLimit).toBe(4_194_304);
  for (const [payload, status, code] of [
    [
      { markdown: "[Guide](https://example.test/guide)", sources: [], brands: [] },
      501,
      "not_implemented",
    ],
    [
      { markdown: "", sources: [{ url: "invalid", position: 1 }], brands: [] },
      400,
      "validation_failed",
    ],
  ] as const) {
    const response = await app.inject({ method: "POST", url: path, payload });
    expect(response.statusCode).toBe(status);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.json()).toMatchObject({ status, code });
    checkResponse("POST", path, status, "application/problem+json", response.json());
  }
});
