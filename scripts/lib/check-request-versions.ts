import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { parse } from "yaml";
import type { Report } from "./check-specs.js";
import { operations, resolver, specsDir, yaml, type Document, type specs } from "./contracts.js";

type Schema = Document | boolean | undefined;
type Site = { file: string; value: Schema };
type Lookup = ReturnType<typeof resolver>;
type Change = (where: string, reason: string) => void;

const child = (site: Site, value: Schema): Site => ({ file: site.file, value });
const isRecord = (value: Schema): value is Document => typeof value === "object" && value !== null;
const record = (value: Schema): Document => (isRecord(value) ? value : {});

function dereference(site: Site, lookup: Lookup): Site {
  const visited = new Set<Schema>();
  while (typeof record(site.value).$ref === "string") {
    if (visited.has(site.value)) throw new Error(site.file + ": circular reference alias");
    visited.add(site.value);
    const ref = record(site.value).$ref;
    site = lookup(site.file, ref);
    if (site.value === undefined) throw new Error(site.file + ": unresolved reference " + ref);
  }
  return site;
}

const upperBounds = ["maxLength", "maxItems", "maximum"] as const;
const lowerBounds = { minLength: 0, minItems: 0, minimum: -Infinity };

function allowedValues(schema: Document): unknown[] | undefined {
  if (Object.hasOwn(schema, "const")) return [schema.const];
  return schema.enum;
}

function narrowsType(
  previous: string | string[] | undefined,
  current: string | string[] | undefined,
) {
  if (current === undefined) return false;
  const types = Array.isArray(current) ? current : [current];
  const original = previous ?? ["null", "boolean", "object", "array", "string", "number"];
  return (Array.isArray(original) ? original : [original]).some(
    (type) => !types.includes(type) && !(type === "integer" && types.includes("number")),
  );
}

function schemaComparer(oldLookup: Lookup, newLookup: Lookup, change: Change) {
  // Compare pairs because either version may reuse the same schema at multiple sites.
  const seen = new Map<Schema, Set<Schema>>();

  function compare(previous: Site, current: Site, where: string) {
    const oldValue = previous.value;
    const newValue = current.value;
    const alreadyCompared = seen.get(oldValue) ?? new Set<Schema>();
    if (alreadyCompared.has(newValue)) return;
    alreadyCompared.add(newValue);
    seen.set(oldValue, alreadyCompared);

    const oldSchema = record(oldValue);
    const newSchema = record(newValue);
    if (oldSchema.$ref || newSchema.$ref) {
      compare(dereference(previous, oldLookup), dereference(current, newLookup), where);
      if (oldSchema.$ref && newSchema.$ref) compareKeywords(previous, current, where);
      else if (newSchema.$ref) compareKeywords(child(previous, true), current, where);
      return;
    }
    if (oldValue === false || newValue === true || newValue === undefined) return;
    if (newValue === false) {
      change(where, "schema now rejects all values");
      return;
    }
    compareKeywords(previous, current, where);
  }

  function compareBranches(previous: Site, current: Site, where: string) {
    for (const keyword of ["allOf", "oneOf", "anyOf"]) {
      const oldBranches: Schema[] = record(previous.value)[keyword] ?? [];
      const remaining: Schema[] = [...(record(current.value)[keyword] ?? [])];
      if (keyword !== "allOf" && !remaining.length) continue;
      const location = where + "." + keyword;
      const pending = oldBranches.filter((branch) => {
        const index = remaining.findIndex(
          (candidate) =>
            isDeepStrictEqual(branch, candidate) ||
            (record(branch).$ref && record(branch).$ref === record(candidate).$ref),
        );
        if (index < 0) return true;
        compare(child(previous, branch), child(current, remaining.splice(index, 1)[0]), location);
        return false;
      });
      for (const branch of pending) {
        const candidate = remaining.shift();
        if (candidate === undefined && keyword !== "allOf") {
          change(location, "an alternative was removed");
        } else {
          compare(child(previous, branch), child(current, candidate), location);
        }
      }
      if (keyword === "allOf") {
        for (const branch of remaining)
          compare(child(previous, true), child(current, branch), location);
      } else if (!oldBranches.length) {
        change(location, "alternatives now constrain the request");
      }
    }
  }

  function compareKeywords(previous: Site, current: Site, where: string) {
    const before = record(previous.value);
    const after = record(current.value);
    if (narrowsType(before.type, after.type)) change(where, "type narrowed");
    const original = allowedValues(before);
    const allowed = allowedValues(after);
    if (allowed && !original) change(where, "values restricted by enum or const");
    else if (
      allowed &&
      original?.some((value) => !allowed.some((next) => isDeepStrictEqual(value, next)))
    )
      change(where, "enum value removed");

    for (const keyword of upperBounds) {
      if (typeof after[keyword] === "number" && after[keyword] < (before[keyword] ?? Infinity))
        change(where, keyword + " lowered to " + after[keyword]);
    }
    for (const [keyword, defaultValue] of Object.entries(lowerBounds)) {
      if (typeof after[keyword] === "number" && after[keyword] > (before[keyword] ?? defaultValue))
        change(where, keyword + " raised to " + after[keyword]);
    }
    for (const name of after.required ?? []) {
      if (!before.required?.includes(name)) change(where, "now requires property " + name);
    }
    for (const [name, value] of Object.entries<Schema>(before.properties ?? {})) {
      const field = where + ".properties." + name;
      if (!Object.hasOwn(after.properties ?? {}, name)) change(field, "property removed");
      else compare(child(previous, value), child(current, after.properties[name]), field);
    }
    for (const keyword of ["items", "additionalProperties", "unevaluatedProperties"]) {
      compare(
        child(previous, before[keyword]),
        child(current, after[keyword]),
        where + "." + keyword,
      );
    }
    compareBranches(previous, current, where);
  }

  return compare;
}

function parameters(file: string, lookup: Lookup, item: Document, op: Document) {
  const entries = [...(item.parameters ?? []), ...(op.parameters ?? [])].map((parameter) => {
    const site = dereference({ file, value: parameter }, lookup);
    const { name, in: location } = record(site.value);
    return [location + " " + name, site] as const;
  });
  return new Map(entries);
}

function requestOperations(file: string, spec: Document, lookup: Lookup) {
  return Object.entries<Schema>(spec.paths ?? {}).flatMap(([path, value]) => {
    const item = dereference({ file, value }, lookup);
    return operations({ paths: { [path]: record(item.value) } }).map((route) => ({
      ...route,
      file: item.file,
    }));
  });
}

function compareRequests(
  file: string,
  previous: Document,
  current: Document,
  oldLookup: Lookup,
  newLookup: Lookup,
  change: Change,
) {
  const key = ({ method, path }: { method: string; path: string }) =>
    method.toUpperCase() + " " + path;
  const routes = new Map(
    requestOperations(file, current, newLookup).map((route) => [key(route), route]),
  );
  for (const old of requestOperations(file, previous, oldLookup)) {
    const operation = key(old);
    const next = routes.get(operation);
    if (!next) {
      change(operation, "operation removed");
      continue;
    }
    const compare = schemaComparer(oldLookup, newLookup, change);
    const oldBody = dereference({ file: old.file, value: old.op.requestBody }, oldLookup);
    const newBody = dereference({ file: next.file, value: next.op.requestBody }, newLookup);
    const a = record(oldBody.value);
    const b = record(newBody.value);
    if (!a.required && b.required) change(operation, "request body is now required");
    for (const [media, definition] of Object.entries<Document>(a.content ?? {})) {
      const where = operation + " requestBody " + media;
      if (!b.content?.[media]) change(where, "media type removed");
      else
        compare(child(oldBody, definition.schema), child(newBody, b.content[media].schema), where);
    }
    const oldParams = parameters(old.file, oldLookup, old.item, old.op);
    const newParams = parameters(next.file, newLookup, next.item, next.op);
    for (const [name, parameter] of newParams) {
      const oldParam = oldParams.get(name);
      const before = record(oldParam?.value);
      const after = record(parameter.value);
      const where = operation + " parameter " + name;
      if (!before.required && after.required) change(where, "parameter is now required");
      if (oldParam) compare(child(oldParam, before.schema), child(parameter, after.schema), where);
    }
    for (const name of oldParams.keys()) {
      if (!newParams.has(name)) change(operation + " parameter " + name, "parameter removed");
    }
  }
}

function git(...args: string[]) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

const major = (version: string) => Number(/^(0|[1-9]\d*)\.\d+\.\d+(?:[-+].+)?$/.exec(version)?.[1]);

export function checkRequestVersions(all: ReturnType<typeof specs>, report: Report) {
  const ref = "refs/remotes/origin/main";
  let baseline: string;
  try {
    baseline = git("rev-parse", "--verify", ref + "^{commit}").trim();
  } catch {
    report("request-version", specsDir, "origin/main is unavailable. Run git fetch origin main.");
    return;
  }
  const oldLookup = resolver((file) => parse(git("show", baseline + ":" + file)));
  const current = new Map(all.map(({ file, spec }) => [file, spec]));
  const newLookup = resolver((file) => current.get(file) ?? yaml(file));
  const files = git("ls-tree", "-r", "--name-only", "-z", baseline, "--", specsDir).split("\0");
  for (const file of files.filter((file) => file.endsWith(".yaml"))) {
    const next = current.get(file);
    const previous = oldLookup(file).document;
    if (!next) {
      report("request-version", file, "service contract removed from origin/main");
      continue;
    }
    if (major(next.info?.version) > major(previous.info?.version)) continue;
    const changes = new Set<string>();
    try {
      compareRequests(file, previous, next, oldLookup, newLookup, (where, reason) =>
        changes.add(where + ": " + reason),
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      report("request-version", file, "could not compare with origin/main: " + reason);
    }
    for (const change of changes) {
      report(
        "request-version",
        file,
        change +
          " (requires an info.version major bump from " +
          previous.info.version +
          " on origin/main)",
      );
    }
  }
}
