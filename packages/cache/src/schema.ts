import { createRequire } from "node:module";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import type { FormatsPlugin } from "ajv-formats";
import { canonicalJson, isObject, own, pointerSegment, pointerValue } from "./json.js";
import type { OperationPolicy } from "./policy.js";

type Schema =
  | boolean
  | {
      $ref?: string;
      allOf?: Schema[];
      anyOf?: Schema[];
      oneOf?: Schema[];
      if?: Schema;
      then?: Schema;
      else?: Schema;
      properties?: Record<string, Schema>;
      patternProperties?: Record<string, Schema>;
      additionalProperties?: Schema;
      prefixItems?: Schema[];
      items?: Schema;
      default?: unknown;
      uniqueItems?: boolean;
    };

interface RequestBody {
  $ref?: string;
  content?: Record<string, { schema?: Schema }>;
}

interface Operation {
  operationId: string;
  requestBody?: RequestBody;
  "x-rex-limits"?: { maxDuration?: string };
}

export interface OperationContract {
  openapi: string;
  info: { version: string };
  paths: Record<string, object>;
  components?: { schemas?: Record<string, object | boolean> };
  "x-rex-service"?: { name: string };
}

const methods = ["get", "post", "put", "patch", "delete", "head", "options", "trace"];
const schemasId = "urn:rex:cache:schemas";
const schemaPrefix = "#/components/schemas/";
const addFormats = createRequire(import.meta.url)("ajv-formats") as FormatsPlugin;
const validators = new WeakMap<OperationContract, (schema: object, value: unknown) => boolean>();

function rebaseRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rebaseRefs);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => {
      if (key !== "$ref") return [key, rebaseRefs(child)];
      if (typeof child !== "string" || !child.startsWith(schemaPrefix))
        throw new Error("Expected a bundled OpenAPI schema reference");
      return [key, schemasId + "#/$defs/" + child.slice(schemaPrefix.length)];
    }),
  );
}

function branchMatcher(contract: OperationContract) {
  const cached = validators.get(contract);
  if (cached) return cached;
  const ajv = new Ajv2020({ strict: false });
  addFormats(ajv);
  ajv.addSchema({ $id: schemasId, $defs: rebaseRefs(contract.components?.schemas ?? {}) });
  const compiled = new WeakMap<object, ValidateFunction>();
  // Compile selectors separately from request validation. Branch matching must never mutate input.
  const matches = (schema: object, value: unknown) => {
    let validate = compiled.get(schema);
    if (!validate) {
      validate = ajv.compile(rebaseRefs(schema) as object);
      compiled.set(schema, validate);
    }
    return validate(value);
  };
  validators.set(contract, matches);
  return matches;
}

export function findOperation(contract: OperationContract, operationId: string) {
  if (!contract.openapi.startsWith("3.1.")) throw new Error("Expected an OpenAPI 3.1 bundle");
  const operations: Operation[] = [];
  for (const path of Object.values(contract.paths)) {
    const item = path as Record<string, Operation | undefined>;
    for (const method of methods) {
      const operation = own(item, method);
      if (operation?.operationId === operationId) operations.push(operation);
    }
  }
  if (operations.length !== 1) throw new Error("Expected one matching OpenAPI operation");
  return operations[0];
}

export function findOperationSchema(contract: OperationContract, operationId: string) {
  let body = findOperation(contract, operationId).requestBody;
  if (!body) return undefined;
  if (body.$ref) body = resolveReference(contract, body.$ref) as RequestBody;
  const schema = body.content?.["application/json"]?.schema;
  if (schema === undefined) throw new Error("Expected an application/json request schema");
  return schema;
}

function resolveReference(contract: OperationContract, ref: string) {
  if (!ref.startsWith("#/")) throw new Error("Expected a bundled OpenAPI reference");
  const schema = pointerValue(contract, decodeURIComponent(ref.slice(1)));
  if (schema === undefined) throw new Error("Unresolved OpenAPI reference: " + ref);
  return schema;
}

function staticSchemas(contract: OperationContract, roots: Schema[]) {
  const schemas = new Set<Schema>();
  const sharedTypes = new Set<"url" | "domain">();
  function visit(schema: Schema) {
    if (schemas.has(schema)) return;
    schemas.add(schema);
    if (typeof schema === "boolean") return;
    if (schema.$ref) {
      if (schema.$ref === schemaPrefix + "Url") sharedTypes.add("url");
      if (schema.$ref === schemaPrefix + "Domain") sharedTypes.add("domain");
      visit(resolveReference(contract, schema.$ref) as Schema);
    }
    schema.allOf?.forEach(visit);
  }
  roots.forEach(visit);
  return { schemas, sharedTypes };
}

function withDefault(contract: OperationContract, value: unknown, roots: Schema[]) {
  if (value !== undefined) return value;
  const defaults = [...staticSchemas(contract, roots).schemas].flatMap((schema) =>
    typeof schema !== "boolean" && Object.hasOwn(schema, "default") ? [schema.default] : [],
  );
  if (
    defaults.length > 1 &&
    !defaults.every((item) => canonicalJson(item) === canonicalJson(defaults[0]))
  )
    throw new Error("Conflicting schema defaults");
  return defaults[0];
}

function activeSchemas(contract: OperationContract, roots: Schema[], value: unknown) {
  const { schemas, sharedTypes } = staticSchemas(contract, roots);
  const matches = (schema: Schema) =>
    typeof schema === "boolean" ? schema : branchMatcher(contract)(schema, value);
  for (const schema of schemas) {
    if (typeof schema === "boolean") continue;
    const branches = [];
    if (schema.if !== undefined) branches.push(matches(schema.if) ? schema.then : schema.else);
    if (schema.anyOf) branches.push(...schema.anyOf.filter(matches));
    if (schema.oneOf) {
      const selected = schema.oneOf.filter(matches);
      if (selected.length !== 1)
        throw new Error("Request does not select exactly one schema branch");
      branches.push(selected[0]);
    }
    for (const branch of branches) {
      if (branch === undefined) continue;
      const active = staticSchemas(contract, [branch]);
      for (const node of active.schemas) schemas.add(node);
      for (const type of active.sharedTypes) sharedTypes.add(type);
    }
  }
  return { schemas: [...schemas].filter((node) => typeof node !== "boolean"), sharedTypes };
}

function childSchemas(schemas: Exclude<Schema, boolean>[], key: string): Schema[] {
  return schemas.flatMap((schema) => {
    const child = own(schema.properties, key);
    const patterns = Object.entries(schema.patternProperties ?? {})
      .filter(([pattern]) => new RegExp(pattern, "u").test(key))
      .map(([, item]) => item);
    if (child !== undefined) patterns.push(child);
    if (!patterns.length && schema.additionalProperties !== undefined)
      patterns.push(schema.additionalProperties);
    return patterns;
  });
}

function normalizeUrl(value: string): string {
  // Parse the authority for ports, but retain the original path and query bytes.
  // Require an explicit host before WHATWG can repair an empty or malformed one.
  const parts = /^(https?:)\/\/([^/?#]+)([^#]*)(?:#.*)?$/is.exec(value);
  if (!parts || /[\\\s\u0000-\u001f\u007f]|%(?![0-9a-f]{2})/i.test(value))
    throw new Error("Cannot safely normalize URL");
  const [, scheme, authority, suffix] = parts;
  const hostParts = /^(.*@)?(\[[^\]]+\]|[^:@]+)(?::\d+)?$/.exec(authority);
  const url = URL.parse(value);
  if (!hostParts || !url || hostParts[2].toLowerCase() !== url.hostname)
    throw new Error("Cannot safely normalize URL authority");
  const hostname = url.hostname.replace(/\.$/, "");
  if (!hostname) throw new Error("Cannot normalize an empty URL host");
  return `${scheme.toLowerCase()}//${hostParts[1] ?? ""}${hostname}${url.port ? ":" + url.port : ""}${suffix}`;
}

export function normalizeRequest(
  contract: OperationContract,
  schema: Schema | undefined,
  operation: OperationPolicy,
  data: unknown,
): unknown {
  const preserve = new Set(operation.preserveArrayOrder);
  const normalize = new Map(
    Object.entries(operation.normalize ?? {}).map(([path, rule]) => [
      path.startsWith("/") ? path : "/" + pointerSegment(path),
      rule,
    ]),
  );
  function visit(value: unknown, roots: Schema[], path: string): unknown {
    if (!roots.length && !normalize.has(path)) return value;
    const effective = withDefault(contract, value, roots);
    const { schemas, sharedTypes } = activeSchemas(contract, roots, effective);
    if (isObject(effective)) {
      const fields = new Set(Object.keys(effective));
      for (const schema of schemas)
        for (const name of Object.keys(schema.properties ?? {})) fields.add(name);
      const result = [];
      for (const name of fields) {
        const children = childSchemas(schemas, name);
        const child = withDefault(contract, own(effective, name), children);
        if (child !== undefined || Object.hasOwn(effective, name))
          result.push([name, visit(child, children, path + "/" + pointerSegment(name))]);
      }
      return Object.fromEntries(result);
    }
    if (Array.isArray(effective)) {
      const items = Array.from(effective, (item, index) => {
        const children = schemas.flatMap((schema) => {
          const child = schema.prefixItems?.[index] ?? schema.items;
          return child === undefined ? [] : [child];
        });
        return visit(item, children, path + "/" + index);
      });
      if (!preserve.has(path) && schemas.some((schema) => schema.uniqueItems))
        return items
          .map((item) => ({ item, canonical: canonicalJson(item) }))
          .sort((a, b) => (a.canonical < b.canonical ? -1 : a.canonical > b.canonical ? 1 : 0))
          .map(({ item }) => item);
      return items;
    }
    if (typeof effective === "string") {
      let normalized = effective;
      if (sharedTypes.has("url")) normalized = normalizeUrl(normalized);
      if (sharedTypes.has("domain")) normalized = normalized.toLowerCase().replace(/\.$/, "");
      if (normalize.get(path) === "collapse-whitespace")
        normalized = normalized.trim().replace(/\s+/g, " ");
      return normalized;
    }
    return effective;
  }
  return visit(data, schema === undefined ? [] : [schema], "");
}
