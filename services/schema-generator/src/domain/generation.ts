import type { components } from "../../contract/types.js";
import { blocks, metadata, parseHtml, readMarkupBlock } from "./html.js";
import { compactNode, expandDocument, expandedTypes } from "./json-ld.js";
import {
  isObject,
  pointer,
  schemaContext,
  schemaProperty,
  schemaTerm,
  schemaVocab,
  urlProperties,
  validationResult,
  type Issue,
  type JsonObject,
  type SchemaType,
} from "./schema.js";
import { validateDocument } from "./validation.js";

const envelopeFields = new Set(["@context", "@type", "type"]);
const hasContent = (fields: JsonObject) =>
  Object.keys(fields).some((key) => !key.startsWith("@") && key !== "id");

// The official context uses HTTP vocabulary IRIs. Treat both Schema.org spellings
// alike for compaction, without rewriting identifiers or literal URL values.
function normalizeTerms(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeTerms);
  if (!isObject(value) || Object.hasOwn(value, "@value")) return value;
  const entries = new Map<string, unknown>();
  for (const [key, child] of Object.entries(value)) {
    const name = schemaTerm(key);
    const normalized = name ? schemaVocab + name : key;
    const terms =
      key === "@type" && Array.isArray(child)
        ? child.map((type) => {
            const term = typeof type === "string" ? schemaTerm(type) : undefined;
            return term ? schemaVocab + term : type;
          })
        : normalizeTerms(child);
    const previous = entries.get(normalized);
    entries.set(normalized, previous !== undefined ? [previous, terms].flat() : terms);
  }
  return Object.fromEntries(entries);
}

function* graphNodes(graph: unknown): Generator<JsonObject> {
  if (Array.isArray(graph)) {
    for (const node of graph) yield* graphNodes(node);
  } else if (isObject(graph) && !Object.hasOwn(graph, "@value")) {
    yield graph;
    for (const child of Object.values(graph)) yield* graphNodes(child);
  }
}

function fieldsFrom(
  source: JsonObject,
  location: string,
  issues: Issue[],
  pageUrl?: string,
): JsonObject {
  function clean(value: unknown, key: string, path: string): unknown {
    if (key === "@context") return value;
    if (Array.isArray(value)) {
      const items = value
        .map((item, i) => clean(item, key, at(path, i)))
        .filter((item) => item !== undefined);
      return items.length ? items : undefined;
    }
    if (isObject(value)) {
      if (Object.hasOwn(value, "@value")) {
        const raw = value["@value"];
        if (raw === null || (typeof raw === "string" && !raw.trim())) return undefined;
        const type = value["@type"];
        const isUrl = typeof type === "string" && schemaProperty(type) === "URL";
        if (typeof raw !== "string" || (!isUrl && !urlProperties.has(schemaProperty(key))))
          return value;
        const literal = clean(raw, "url", at(path, "@value"));
        return literal === undefined ? undefined : { ...value, "@value": literal };
      }
      const fields = cleanObject(value, path);
      return Object.keys(fields).length ? fields : undefined;
    }
    if (value === null || value === undefined) return undefined;
    if (typeof value !== "string") return value;
    const text = value.trim();
    if (!text) return undefined;
    const identifier = key === "@id" || key === "id";
    if (!identifier && !urlProperties.has(schemaProperty(key))) return value;
    if (identifier && text.startsWith("_:")) return text;
    if (URL.canParse(text)) return text;
    if (pageUrl && URL.canParse(text, pageUrl)) return new URL(text, pageUrl).href;
    issues.push({
      severity: "warning",
      code: "unresolved_url",
      message: "A URL could not be resolved and was omitted.",
      pointer: path,
    });
    return undefined;
  }
  function at(path: string, key: string | number) {
    return path.startsWith("line:") ? path : pointer(path, key);
  }
  function cleanObject(value: JsonObject, root: string) {
    return Object.fromEntries(
      Object.entries(value)
        .map(([key, child]) => [key === "id" ? "@id" : key, clean(child, key, at(root, key))])
        .filter(([, child]) => child !== undefined),
    );
  }
  return cleanObject(
    Object.fromEntries(Object.entries(source).filter(([key]) => !envelopeFields.has(key))),
    location,
  );
}

async function htmlFields(
  source: components["schemas"]["FromHtml"],
  schemaType: SchemaType,
  issues: Issue[],
) {
  const $ = parseHtml(source.html);
  const { pageUrl } = source;
  function fillMissing(fields: JsonObject) {
    const tags = metadata($, schemaType);
    for (const values of [tags.og, tags.html]) {
      for (const [key, located] of Object.entries(values)) {
        if (located && !Object.hasOwn(fields, key)) {
          Object.assign(
            fields,
            fieldsFrom({ [key]: located.value }, located.pointer, issues, pageUrl),
          );
        }
      }
    }
    return fields;
  }
  for (const block of blocks($)) {
    const document = readMarkupBlock(block.text);
    if (!document) continue;
    const expanded = await expandDocument(document.value, block.pointer, pageUrl);
    if ("issue" in expanded) continue;
    for (const node of graphNodes(expanded.graph)) {
      if (!expandedTypes(node).some((type) => schemaTerm(type) === schemaType)) continue;
      const compact = await compactNode(normalizeTerms(node) as JsonObject, pageUrl);
      const fields = fieldsFrom(compact, block.pointer, issues, pageUrl);
      if (hasContent(fields)) return fillMissing(fields);
    }
  }
  return fillMissing({});
}

export async function generateMarkup(
  request: components["schemas"]["SchemaMarkupRequest"],
): Promise<components["schemas"]["SchemaMarkup"] | undefined> {
  const { source, schemaType } = request;
  const issues: Issue[] = [];
  const fields =
    "html" in source
      ? await htmlFields(source, schemaType, issues)
      : fieldsFrom(source.data, "/source/data", issues);
  if (!hasContent(fields)) return undefined;

  const jsonLd: JsonObject = { "@context": schemaContext, "@type": schemaType, ...fields };
  if ("html" in source && source.pageUrl) jsonLd.url = source.pageUrl;
  const serialized = JSON.stringify(jsonLd).replaceAll("<", "\\u003c");
  issues.push(...(await validateDocument(jsonLd, "/jsonLd")));
  return {
    schemaType,
    jsonLd,
    scriptTag: '<script type="application/ld+json">' + serialized + "</script>",
    validation: validationResult(issues),
  };
}
