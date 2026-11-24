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
type RuleGroup = { rules: Rule[]; hasDisallow: boolean; key: string };

type GroupMembership = { ids: number[]; rules: Rule[]; hasDisallow: boolean };

export function scanGroups(content: string, tokens: readonly string[]): Map<string, RuleGroup> {
  const tracked = new Set(["*", ...tokens.map((token) => token.toLowerCase())]);
  const groups = new Map<string, GroupMembership>();
  const directives = new Map<string, { rule: Rule; groups: Set<GroupMembership> }>();
  let agents = new Set<string>();
  let lastWasAgent = false;
  for (const line of content.split(/\r\n|\r|\n/u)) {
    const comment = line.indexOf("#");
    const directive = comment < 0 ? line : line.slice(0, comment);
    const colon = directive.indexOf(":");
    if (colon < 0) continue;
    const name = directive.slice(0, colon).trim().toLowerCase();
    if (!name) continue;
    if (name === "user-agent") {
      if (!lastWasAgent) agents = new Set();
      const token = directive
        .slice(colon + 1)
        .split("/", 1)[0]
        .trim()
        .toLowerCase();
      if (tracked.has(token)) agents.add(token);
    } else if (agents.size && (name === "allow" || name === "disallow" || name === "crawl-delay")) {
      // Empty rules and Crawl-delay register a group in the pinned parser.
      const pattern = name === "crawl-delay" ? "" : directive.slice(colon + 1).trim();
      let entry;
      if (pattern) {
        const allow = name === "allow";
        const key = (allow ? "+" : "-") + pattern;
        entry = directives.get(key);
        if (!entry) {
          entry = { rule: { pattern, allow }, groups: new Set<GroupMembership>() };
          directives.set(key, entry);
        }
      }
      for (const agent of agents) {
        let group = groups.get(agent);
        if (!group) {
          group = { ids: [], rules: [], hasDisallow: false };
          groups.set(agent, group);
        }
        if (entry && !entry.groups.has(group)) {
          entry.groups.add(group);
          group.rules.push(entry.rule);
          if (!entry.rule.allow) group.hasDisallow = true;
        }
      }
    }
    lastWasAgent = name === "user-agent";
  }

  // Build ordered identities in one pass over the distinct directives. Repeated
  // groups contribute to the same set. Each rule's pattern is stored only once.
  let id = 0;
  for (const { groups: members } of directives.values()) {
    for (const group of members) group.ids.push(id);
    id++;
  }
  return new Map(
    [...groups].map(([agent, { ids, rules, hasDisallow }]) => [
      agent,
      { key: ids.join(","), rules, hasDisallow },
    ]),
  );
}
