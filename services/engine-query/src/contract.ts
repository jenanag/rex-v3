import { createRequire } from "node:module";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { FormatsPlugin } from "ajv-formats";

type Schema = boolean | Record<string, unknown>;
type Media = Record<string, { schema: Schema }>;
type Response = { content?: Media } | { $ref: string };
export type Operation = {
  operationId: string;
  parameters?: unknown[];
  requestBody?: { required?: boolean; content: Media };
  responses: Record<string, Response>;
};
type PathItem = Record<string, unknown> & { parameters?: unknown[] };
export type ToolSpec = {
  openapi: string;
  info: { version: string };
  paths: Record<string, PathItem>;
  components?: { schemas?: Record<string, Schema>; responses?: Record<string, Response> };
};

export const addFormats = createRequire(import.meta.url)("ajv-formats") as FormatsPlugin;
const schemasId = "urn:rex:tool:schemas";
const schemaPrefix = "#/components/schemas/";

function rebaseRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rebaseRefs);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => {
      if (key !== "$ref") return [key, rebaseRefs(child)];
      if (typeof child !== "string" || !child.startsWith(schemaPrefix)) {
        throw new Error("Expected a bundled schema reference: " + child);
      }
      return [key, schemasId + "#/$defs/" + child.slice(schemaPrefix.length)];
    }),
  );
}

export function validators(spec: ToolSpec, useDefaults: boolean) {
  const ajv = new Ajv2020({
    strict: true,
    allErrors: true,
    removeAdditional: false,
    coerceTypes: false,
    useDefaults,
  });
  addFormats(ajv);
  for (const keyword of ["example", "x-rex-service", "x-rex-public", "x-rex-limits"])
    ajv.addKeyword(keyword);
  ajv.addSchema({ $id: schemasId, $defs: rebaseRefs(spec.components?.schemas ?? {}) });
  return (schema: Schema) => ajv.compile(rebaseRefs(schema) as Schema);
}

export function responseMedia(spec: ToolSpec, response: Response) {
  if (!("$ref" in response)) return response.content;
  const prefix = "#/components/responses/";
  if (!response.$ref.startsWith(prefix))
    throw new Error("Expected a bundled response reference: " + response.$ref);
  const definition = spec.components?.responses?.[response.$ref.slice(prefix.length)];
  if (!definition || "$ref" in definition)
    throw new Error("Missing bundled response: " + response.$ref);
  return definition.content;
}

export function* contractRoutes(spec: ToolSpec) {
  const methods = new Set(["get", "post", "put", "patch", "delete", "head", "options", "trace"]);
  const ids = new Set<string>();
  if (!spec.openapi.startsWith("3.1.")) throw new Error("Expected a bundled OpenAPI 3.1 tool spec");
  for (const [path, item] of Object.entries(spec.paths)) {
    if (item.parameters?.length || "$ref" in item || path.includes("{"))
      throw new Error("Unsupported tool path item: " + path);
    for (const [method, value] of Object.entries(item)) {
      if (!methods.has(method)) continue;
      const op = value as Operation;
      if (!op.operationId || ids.has(op.operationId))
        throw new Error("Missing or duplicate operationId for " + method + " " + path);
      ids.add(op.operationId);
      if (
        op.parameters?.length ||
        (op.requestBody &&
          (!op.requestBody.required ||
            Object.keys(op.requestBody.content).join() !== "application/json"))
      ) {
        throw new Error("Unsupported tool request: " + op.operationId);
      }
      yield { method, path, op };
    }
  }
}
