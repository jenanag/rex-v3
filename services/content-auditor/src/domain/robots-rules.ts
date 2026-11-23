import { createRequire } from "node:module";

export const robotsParser = createRequire(import.meta.url)(
  "robots-parser",
) as typeof import("robots-parser").default;

export function sameOrigin(left: URL, right: URL): boolean {
  return left.origin === right.origin;
}

export function readableRobots(status: number | null, content: string | null): content is string {
  return status !== null && status >= 200 && status < 300 && content !== null;
}

export type Rule = { pattern: string; allow: boolean };
type RuleGroup = { segments: Rule[][]; hasDisallow: boolean };

// Mirror the group registration in robots-parser 3.0.1. Keep each segment's rules
// once, even when many agents share it. Expand only a selected group, under budget.
export function scanGroups(content: string, tokens: readonly string[]): Map<string, RuleGroup> {
  const tracked = new Set(["*", ...tokens.map((token) => token.toLowerCase())]);
  const groups = new Map<string, RuleGroup>();
  let agents = new Set<string>();
  let lastWasAgent = false;
  let segment: Rule[] | undefined;
  let segmentHasDisallow = false;
  for (const line of content.split(/\r\n|\r|\n/u)) {
    const comment = line.indexOf("#");
    const directive = comment < 0 ? line : line.slice(0, comment);
    const colon = directive.indexOf(":");
    if (colon < 0) continue;
    const name = directive.slice(0, colon).trim().toLowerCase();
    if (!name) continue;
    if (name === "user-agent") {
      if (!lastWasAgent) {
        agents = new Set();
        segment = undefined;
        segmentHasDisallow = false;
      }
      const token = directive
        .slice(colon + 1)
        .split("/", 1)[0]
        .trim()
        .toLowerCase();
      if (tracked.has(token)) agents.add(token);
    } else if (agents.size && (name === "allow" || name === "disallow" || name === "crawl-delay")) {
      if (!segment) {
        segment = [];
        for (const agent of agents) {
          if (!groups.has(agent)) groups.set(agent, { segments: [], hasDisallow: false });
        }
      }
      if (name !== "crawl-delay") {
        const pattern = directive.slice(colon + 1).trim();
        if (pattern) {
          if (segment.length === 0) {
            for (const agent of agents) groups.get(agent)!.segments.push(segment);
          }
          if (name === "disallow" && !segmentHasDisallow) {
            segmentHasDisallow = true;
            for (const agent of agents) groups.get(agent)!.hasDisallow = true;
          }
          segment.push({ pattern, allow: name === "allow" });
        }
      }
    }
    lastWasAgent = name === "user-agent";
  }
  return groups;
}
