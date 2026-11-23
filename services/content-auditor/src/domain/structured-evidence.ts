import type { CheerioAPI } from "cheerio";
import { finding, httpUrl, type Finding } from "./types.js";

type JsonObject = Record<string, unknown>;
type Node = { value: JsonObject; schemaContext: boolean };
type Block = { nodes: Node[]; warn: boolean };

const schemaContextUrl = /^https?:\/\/schema\.org\/?$/;
const nonblank = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";
const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : [value]);

function parseBlock(text: string): Block | undefined {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return undefined;
  }
  const roots = array(root);
  if (!roots.length || !roots.every(isObject)) return undefined;
  const stack = roots.map((value) => ({ value, schemaContext: false })).reverse();
  const nodes: Node[] = [];
  let warn = false;

  while (stack.length) {
    const { value, schemaContext: inherited } = stack.pop()!;
    const context = value["@context"];
    const explicitContext = typeof context === "string" && schemaContextUrl.test(context);
    const schemaContext = context === undefined ? inherited : explicitContext;
    const type = value["@type"];
    const id = value["@id"];
    const graph = value["@graph"];

    if (type !== undefined && (!array(type).length || !array(type).every(nonblank)))
      return undefined;
    if (id !== undefined && !nonblank(id)) return undefined;
    if (graph !== undefined) {
      const children = array(graph);
      if (!children.length || !children.every(isObject)) return undefined;
      for (let index = children.length - 1; index >= 0; index--)
        stack.push({ value: children[index], schemaContext });
    }

    warn ||=
      (context !== undefined && !explicitContext) ||
      (type === undefined && id === undefined && graph === undefined);
    nodes.push({ value, schemaContext });
  }
  return { nodes, warn };
}

export function readStructuredData(dom: CheerioAPI | undefined) {
  return (
    dom?.("script[type]")
      .toArray()
      .filter(
        (element) => dom(element).attr("type")?.trim().toLowerCase() === "application/ld+json",
      )
      .map((element) => parseBlock(dom(element).text())) ?? []
  );
}

export function structuredChecks(
  dom: CheerioAPI | undefined,
  blocks: ReturnType<typeof readStructuredData>,
): Finding[] {
  const presence = !dom ? "not_applicable" : blocks.length ? "pass" : "fail";
  const present = finding(
    "jsonld_present",
    presence,
    !dom
      ? "No eligible HTML was supplied."
      : blocks.length
        ? "Embedded JSON-LD is present."
        : "No embedded JSON-LD was found.",
  );
  const id = "jsonld_shape";
  if (!blocks.length)
    return [
      present,
      finding(id, "not_applicable", "No embedded JSON-LD blocks were available to check."),
    ];
  if (!blocks.some(Boolean))
    return [
      present,
      finding(id, "fail", "Every embedded JSON-LD block has a JSON or node shape error."),
    ];
  if (blocks.some((block) => !block || block.warn))
    return [
      present,
      finding(
        id,
        "warn",
        "Some JSON-LD blocks have shape errors, lack node signals, or use a context unsupported by the local check.",
      ),
    ];
  return [
    present,
    finding(id, "pass", "All embedded JSON-LD blocks passed the local syntax and shape checks."),
  ];
}

function hasType(node: Node, type: string) {
  return array(node.value["@type"]).some(
    (value) =>
      value === "http://schema.org/" + type ||
      value === "https://schema.org/" + type ||
      (node.schemaContext && value === type),
  );
}

function structuredIdentities(nodes: Node[]): Node[] {
  const identities: Node[] = [];
  const authorIds = new Set<string>();
  for (const node of nodes) {
    for (const author of array(node.value.author)) {
      const ref =
        typeof author === "string" ? author : isObject(author) ? author["@id"] : undefined;
      if (nonblank(ref)) authorIds.add(ref);
      if (!isObject(author)) continue;
      const context = author["@context"];
      const inline = {
        value: author,
        schemaContext:
          context === undefined
            ? node.schemaContext
            : typeof context === "string" && schemaContextUrl.test(context),
      };
      if (hasType(inline, "Person") || hasType(inline, "Organization")) identities.push(inline);
    }
  }
  return identities.concat(
    nodes.filter((node) => {
      const id = node.value["@id"];
      return (
        hasType(node, "Organization") ||
        (nonblank(id) && authorIds.has(id) && hasType(node, "Person"))
      );
    }),
  );
}

export function entityChecks(dom: CheerioAPI | undefined, nodes: Node[]): Finding[] {
  const identities = structuredIdentities(nodes);
  const named = identities.filter(({ value }) => nonblank(value.name));
  const authorTag = dom?.("meta[name]")
    .toArray()
    .some(
      (element) =>
        dom(element).attr("name")?.trim().toLowerCase() === "author" &&
        nonblank(dom(element).attr("content")),
    );
  const id = "entity_identity";
  const identity = !dom
    ? finding(id, "not_applicable", "No eligible HTML was supplied.")
    : named.length
      ? finding(id, "pass", "A named structured organization or author was found.")
      : authorTag || identities.length
        ? finding(id, "warn", "HTML names an author or structured data has an unnamed identity.")
        : finding(id, "fail", "No supported organization or author identity was found.");

  const links = named.flatMap(({ value }) =>
    Object.hasOwn(value, "sameAs") ? array(value.sameAs) : [],
  );
  const usable = links.filter(
    (link) => nonblank(link) && /^https?:\/\//i.test(link.trim()) && httpUrl(link.trim()),
  );
  const sameAs = "entity_same_as";
  const external = !named.length
    ? finding(sameAs, "not_applicable", "No named structured identity was found.")
    : !links.length
      ? finding(sameAs, "warn", "Named structured identities have no sameAs links.")
      : !usable.length
        ? finding(sameAs, "fail", "No supplied sameAs link is an absolute HTTP(S) URL.")
        : usable.length < links.length
          ? finding(sameAs, "warn", "Usable and invalid sameAs links are mixed.")
          : finding(sameAs, "pass", "All supplied sameAs links are absolute HTTP(S) URLs.");
  return [identity, external];
}

type DateRole = "published" | "updated" | "unlabelled";
type DateEvidence = { role: DateRole; value: unknown };

function utcDay(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const time =
    /^(\d{4}-\d{2}-\d{2})(?:[Tt](?:[01]\d|2[0-3]):[0-5]\d:([0-5]\d|60)(?:\.\d+)?(?:[Zz]|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/.exec(
      value.trim(),
    );
  if (!time) return undefined;
  const date = new Date(time[1] + "T00:00:00Z");
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== time[1])
    return undefined;
  if (time[2] === undefined) return date.getTime() / 86_400_000;
  const stamp = value.trim();
  // Date cannot parse leap seconds. Validate their UTC position as the final second of June or December.
  const leap = time[2] === "60";
  const parsed = new Date(leap ? stamp.slice(0, 17) + "59" + stamp.slice(19) : stamp);
  if (!Number.isFinite(parsed.getTime())) return undefined;
  const iso = parsed.toISOString();
  if (leap && !/(?:06-30|12-31)T23:59:59\./.test(iso)) return undefined;
  return Math.floor(parsed.getTime() / 86_400_000);
}

export function freshnessCheck(dom: CheerioAPI | undefined, nodes: Node[], text: string): Finding {
  const dates: DateEvidence[] = [];
  for (const { value } of nodes) {
    if (Object.hasOwn(value, "datePublished"))
      dates.push({ role: "published", value: value.datePublished });
    if (Object.hasOwn(value, "dateModified"))
      dates.push({ role: "updated", value: value.dateModified });
  }
  dom?.("time[datetime]").each((_index, element) => {
    const time = dom(element);
    const itemprop = time.attr("itemprop")?.split(/\s+/) ?? [];
    const role = itemprop.includes("datePublished")
      ? "published"
      : itemprop.includes("dateModified")
        ? "updated"
        : "unlabelled";
    dates.push({ role, value: time.attr("datetime") });
  });
  for (const line of text.split(/\r\n?|\n/)) {
    const label = /^\s*(published|updated)\s*:\s*(.*)$/i.exec(line);
    if (label)
      dates.push({
        role: label[1].toLowerCase() === "published" ? "published" : "updated",
        value: label[2],
      });
  }

  const id = "freshness_dates";
  if (!dates.length)
    return finding(id, "not_applicable", "No supported date signals were supplied.");
  const chosen = new Map<DateRole, number>();
  let warning = false;
  for (const { role, value } of dates) {
    const day = utcDay(value);
    if (day === undefined) warning = true;
    else if (!chosen.has(role)) chosen.set(role, day);
    else if (role !== "unlabelled" && chosen.get(role) !== day) warning = true;
  }
  if (!chosen.size) return finding(id, "fail", "All supplied date signals are invalid.");
  const published = chosen.get("published");
  const updated = chosen.get("updated");
  if (published !== undefined && updated !== undefined && updated < published)
    return finding(id, "fail", "The selected update date predates publication.");
  return warning
    ? finding(id, "warn", "Some supplied dates are invalid or disagree for the same role.")
    : finding(id, "pass", "Supplied date evidence is valid and consistent.");
}
