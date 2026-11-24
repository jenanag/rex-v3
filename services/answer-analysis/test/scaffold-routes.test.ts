import { expect, test } from "vitest";
import { checkResponse, tool } from "./support.js";

test("the scaffold registers both operations with the default 3 MiB limit", async () => {
  const app = tool();
  try {
    expect(app.initialConfig.bodyLimit).toBe(3_145_728);
    const post = {
      method: "POST",
      url: "/v1/answer-analyses",
      payload: {
        text: "Acme is mentioned.",
        brands: [{ key: "acme", kind: "primary", name: "Acme", aliases: [], domains: [] }],
      },
    } as const;
    for (const request of [post, { method: "GET", url: "/v1/analyzers" } as const]) {
      const response = await app.inject(request);
      const problem = response.json();
      expect(response.statusCode).toBe(501);
      expect(problem.code).toBe("not_implemented");
      checkResponse(request.method, request.url, 501, "application/problem+json", problem);
    }
  } finally {
    await app.close();
  }
});
