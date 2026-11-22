import jsonld, { type ActiveContext } from "jsonld";
import context from "../data/schemaorg-context.json" with { type: "json" };
import {
  isObject,
  pointer,
  properties,
  schemaContext,
  schemaRelease,
  schemaTerm,
  types,
  type Issue,
  type JsonObject,
} from "./schema.js";

const contextPaths = [
  "",
  "/",
  "/docs/jsonldcontext.json",
  "/version/" + schemaRelease + "/schemaorgcontext.jsonld",
];
const contextUrls = new Set(
  ["http://schema.org", schemaContext].flatMap((origin) =>
    contextPaths.map((path) => origin + path),
  ),
);

class DisallowedContext extends Error {
  constructor(readonly url: string) {
    super("Remote context is outside the vendored Schema.org context.");
  }
}

async function documentLoader(url: string) {
  if (!contextUrls.has(url)) throw new DisallowedContext(url);
  return { documentUrl: url, contextUrl: null, document: context, tag: "static" as const };
}

function options(base = "") {
  return { base, documentLoader, compactToRelative: false };
}

// JSON-LD errors can wrap the loader failure in details.cause.
function blockedContext(error: unknown): DisallowedContext | undefined {
  if (error instanceof DisallowedContext) return error;
  if (isObject(error) && isObject(error.details) && error.details.cause)
    return blockedContext(error.details.cause);
}

function contextLocation(value: unknown, url: string, path: string): string | undefined {
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      const found = contextLocation(child, url, pointer(path, index));
      if (found) return found;
    }
  } else if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      const here = pointer(path, key);
      if (key === "@import" && child === url) return here;
      if (key === "@context") {
        if (child === url) return here;
        if (Array.isArray(child)) {
          const index = child.indexOf(url);
          if (index >= 0) return pointer(here, index);
        }
      }
      const found = contextLocation(child, url, here);
      if (found) return found;
    }
  }
}

export async function expandDocument(
  document: unknown,
  root: string,
  pageUrl?: string,
): Promise<{ graph: JsonObject[] } | { issue: Issue }> {
  try {
    // A string is a remote document URL to jsonld.js. Only expand supplied objects or arrays.
    if (!isObject(document) && !Array.isArray(document))
      throw new Error("Expected a JSON-LD object or array");
    return { graph: await jsonld.expand(document, options(pageUrl)) };
  } catch (error) {
    const blocked = blockedContext(error);
    if (blocked) {
      return {
        issue: {
          severity: "error",
          code: "disallowed_remote_context",
          message: blocked.message,
          pointer: root.startsWith("line:")
            ? root
            : (contextLocation(document, blocked.url, root) ?? root),
        },
      };
    }
    return {
      issue: {
        severity: "error",
        code: "jsonld_expansion_failed",
        message: "The supplied JSON-LD could not be expanded.",
        pointer: root,
      },
    };
  }
}

export const expandedTypes = (node: JsonObject): string[] =>
  Array.isArray(node["@type"]) ? node["@type"].filter((term) => typeof term === "string") : [];

type UnknownTerm = { kind: "type" | "property"; name: string };

function inspectGraph(graph: JsonObject[]) {
  const terms = new Map<string, UnknownTerm>();
  let hasNode = false;
  let typed = false;
  function check(iri: string, kind: UnknownTerm["kind"]) {
    const name = schemaTerm(iri);
    const known = kind === "type" ? types : properties;
    if (name && !known.has(name)) terms.set(kind + ":" + name, { kind, name });
  }
  function inspect(value: unknown) {
    if (Array.isArray(value)) {
      value.forEach(inspect);
    } else if (isObject(value) && !Object.hasOwn(value, "@value")) {
      const names = expandedTypes(value);
      if (names.length) typed = true;
      for (const [key, child] of Object.entries(value)) {
        if (!key.startsWith("@") || key === "@type" || key === "@id") hasNode = true;
        check(key, "property");
        if (key !== "@type") inspect(child);
      }
      names.forEach((name) => check(name, "type"));
    }
  }
  inspect(graph);
  return { terms, untyped: hasNode && !typed };
}

function expandedTerm(term: string, ctx: ActiveContext) {
  if (ctx.mappings.has(term)) return ctx.mappings.get(term)?.["@id"];
  const separator = term.indexOf(":");
  if (separator > 0) {
    const prefix = ctx.mappings.get(term.slice(0, separator));
    return prefix?._prefix ? String(prefix["@id"]) + term.slice(separator + 1) : term;
  }
  return term.startsWith("@") || !ctx["@vocab"] ? term : ctx["@vocab"] + term;
}

async function originalLocations(document: unknown, root: string, terms: Map<string, UnknownTerm>) {
  const locations = new Map<string, string[]>();
  function record(kind: UnknownTerm["kind"], iri: unknown, path: string) {
    if (typeof iri !== "string") return;
    const name = schemaTerm(iri);
    const key = kind + ":" + name;
    if (!terms.has(key)) return;
    const matches = locations.get(key) ?? [];
    matches.push(path);
    locations.set(key, matches);
  }
  async function visit(value: unknown, path: string, active: ActiveContext) {
    if (Array.isArray(value)) {
      for (const [index, child] of value.entries())
        await visit(child, pointer(path, index), active);
      return;
    }
    if (!isObject(value)) return;
    const ctx = Object.hasOwn(value, "@context")
      ? await jsonld.processContext(active, value["@context"], options())
      : active;
    for (const [key, child] of Object.entries(value)) {
      if (key === "@context") continue;
      const here = pointer(path, key);
      const iri = expandedTerm(key, ctx);
      if (iri === "@type") {
        for (const [index, name] of (Array.isArray(child) ? child : [child]).entries()) {
          if (typeof name === "string")
            record(
              "type",
              expandedTerm(name, ctx),
              Array.isArray(child) ? pointer(here, index) : here,
            );
        }
      } else if (iri !== "@value") {
        record("property", iri, here);
        await visit(child, here, ctx);
      }
    }
  }
  try {
    await visit(document, root, await jsonld.processContext(null, null, options()));
  } catch {
    // Contexts scoped to a property or type can require a different active context.
    // The document-level pointer is still valid when a precise match cannot be located.
    return new Map<string, string[]>();
  }
  return locations;
}

export async function vocabularyIssues(document: unknown, graph: JsonObject[], root: string) {
  const { terms, untyped } = inspectGraph(graph);
  const locations =
    terms.size && !root.startsWith("line:")
      ? await originalLocations(document, root, terms)
      : new Map();
  const issues: Issue[] = [];
  for (const [key, { kind, name }] of terms) {
    for (const path of locations.get(key) ?? [root]) {
      issues.push({
        severity: "warning",
        code: "unknown_schema_" + kind,
        message: "Unknown Schema.org " + kind + " " + name + ".",
        pointer: path,
      });
    }
  }
  if (untyped)
    issues.push({
      severity: "warning",
      code: "untyped_graph",
      message: "The expanded graph contains no typed node.",
      pointer: root,
    });
  return issues;
}

export async function compactNode(node: JsonObject, pageUrl?: string) {
  return jsonld.compact(node, schemaContext, options(pageUrl));
}
