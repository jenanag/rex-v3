import { afterAll, expect, test } from "vitest";
import { checkResponse, tool } from "./support.js";

const app = tool();
afterAll(() => app.close());

const siteUrl = "https://example.org/";
const requests = [
  {
    path: "/v1/audits",
    payload: {
      url: siteUrl,
      page: { finalUrl: siteUrl, status: 200, headers: {}, html: "<h1>Guide</h1>" },
      content: { text: "Guide", markdown: "# Guide" },
    },
  },
  {
    path: "/v1/crawler-checks",
    payload: { siteUrl, robotsTxt: { url: siteUrl + "robots.txt", status: 404, content: null } },
  },
];

test.each(requests)(
  "$path validates the request before entering its 501 stub",
  async ({ path, payload }) => {
    for (const [body, status, code] of [
      [payload, 501, "not_implemented"],
      [{}, 400, "validation_failed"],
    ] as const) {
      const response = await app.inject({ method: "POST", url: path, payload: body });
      expect(response.statusCode).toBe(status);
      expect(response.headers["content-type"]).toContain("application/problem+json");
      const result: unknown = response.json();
      expect(result).toMatchObject({ status, code });
      checkResponse("POST", path, status, "application/problem+json", result);
    }
  },
);
