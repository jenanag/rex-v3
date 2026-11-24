import type { components } from "../../contract/types.js";
import { ToolProblem } from "../errors.js";
import { createGroupEvaluator } from "./robots-access-search.js";
import { readableRobots, sameOrigin, scanGroups } from "./robots-rules.js";
import { httpUrl, type AiCrawler } from "./types.js";

export type CrawlerCheckRequest = components["schemas"]["CrawlerCheckRequest"];
type CrawlerCheck = components["schemas"]["CrawlerCheck"];
type Access = components["schemas"]["CrawlerAccess"];

export function checkCrawlerAccess(
  input: CrawlerCheckRequest,
  crawlers: readonly AiCrawler[],
): CrawlerCheck {
  const { siteUrl, robotsTxt } = input;
  const site = httpUrl(siteUrl);
  if (!site)
    throw new ToolProblem(422, "invalid_crawler_url", "/siteUrl must be a valid HTTP(S) URL.");
  const file = httpUrl(robotsTxt.url);
  if (!file)
    throw new ToolProblem(
      422,
      "invalid_crawler_url",
      "/robotsTxt/url must be a valid HTTP(S) URL.",
    );
  if (!sameOrigin(site, file))
    throw new ToolProblem(
      422,
      "robots_origin_mismatch",
      "/robotsTxt/url must have the same origin as /siteUrl.",
    );

  const { status, content } = robotsTxt;
  const result = { siteUrl, robotsTxtUrl: robotsTxt.url, robotsTxtStatus: status };
  if (!readableRobots(status, content)) {
    const access: Access = status !== null && status >= 400 && status < 500 ? "allowed" : "unknown";
    return {
      ...result,
      crawlers: crawlers.map((crawler) => ({ ...crawler, access, matchedGroup: null })),
    };
  }

  const groups = scanGroups(
    content,
    crawlers.map(({ robotsToken }) => robotsToken),
  );
  const evaluate = createGroupEvaluator(site.origin);
  const results = new Map<string, Access>();
  return {
    ...result,
    crawlers: crawlers.map((crawler) => {
      const token = crawler.robotsToken.toLowerCase();
      const group = groups.has(token) ? token : groups.has("*") ? "*" : null;
      if (group === null) return { ...crawler, access: "allowed", matchedGroup: null };
      const { key, rules, hasDisallow } = groups.get(group)!;
      const access = results.get(key) ?? (hasDisallow ? evaluate(rules) : "allowed");
      results.set(key, access);
      return { ...crawler, access, matchedGroup: group === "*" ? "*" : crawler.robotsToken };
    }),
  };
}
