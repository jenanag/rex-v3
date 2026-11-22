import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parse } from "yaml";

export const contractsDir = "packages/contracts";
export const specsDir = join(contractsDir, "openapi/services");
export const commonFile = join(contractsDir, "openapi/common.yaml");
export const eventsFile = join(contractsDir, "asyncapi/events.yaml");
export const topologyFile = join(contractsDir, "bus/topology.yaml");
export const policyFile = join(contractsDir, "cache/policy.yaml");
export const manifestFile = join(contractsDir, "vendoring.yaml");
export const currentPhase = 1;

// YAML documents are inspected by the rule that owns each part of their schema.
export type Document = Record<string, any>;

export const read = (file: string) => readFileSync(file, "utf8");
export const yaml = (file: string): Document => parse(read(file));
export const json = (file: string): Document => JSON.parse(read(file));
export const serviceDoc = (name: string) => join("docs/services", name + ".md");
export const toolDir = (name: string) => join("services", name);

export function files(dir: string, suffix?: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((item) => {
      const path = join(dir, item.name);
      if (item.isDirectory()) {
        return ["node_modules", ".git", ".venv", "dist", "coverage", "__pycache__"].includes(
          item.name,
        )
          ? []
          : files(path, suffix);
      }
      return !suffix || path.endsWith(suffix) ? [path] : [];
    })
    .sort();
}

export function* nodes(value: unknown, path: string[] = []): Generator<[Document, string[]]> {
  if (!value || typeof value !== "object") return;
  if (!Array.isArray(value)) yield [value as Document, path];
  for (const [key, child] of Object.entries(value)) yield* nodes(child, [...path, key]);
}

export function pointer(value: any, fragment: string) {
  if (!fragment || fragment === "#") return value;
  if (!fragment.startsWith("#/")) return undefined;
  return decodeURIComponent(fragment.slice(2))
    .split("/")
    .reduce((current, part) => {
      const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
      return current && Object.hasOwn(current, key) ? current[key] : undefined;
    }, value);
}

export type Located = { value: Document; file: string; document: Document };
export function resolver() {
  const documents = new Map<string, Document>();
  return function lookup(file: string, ref = ""): Located {
    const [source, anchor = ""] = ref.split("#");
    const target = source ? join(dirname(file), source) : file;
    if (!documents.has(target)) documents.set(target, yaml(target));
    const document = documents.get(target)!;
    return { file: target, document, value: pointer(document, anchor ? "#" + anchor : "") };
  };
}

const methods = new Set(["get", "post", "put", "patch", "delete", "head", "options", "trace"]);
export function operations(spec: Document) {
  return Object.entries<Document>(spec.paths ?? {}).flatMap(([path, item]) =>
    Object.entries<Document>(item)
      .filter(([method]) => methods.has(method))
      .map(([method, op]) => ({ path, method, op, item })),
  );
}

export function specs() {
  return files(specsDir, ".yaml").map((file) => {
    const spec = yaml(file);
    return {
      file,
      spec,
      name: spec["x-rex-service"].name as string,
      kind: spec["x-rex-service"].kind as string,
    };
  });
}

export function table(text: string, section: RegExp) {
  const offset = text.search(section);
  if (offset < 0) return [];
  const lines = text.slice(offset).split("\n");
  const first = lines.findIndex((line) => line.startsWith("|"));
  if (first < 0 || lines.slice(1, first).some((line) => line.startsWith("#"))) return [];
  const end = lines.findIndex((line, i) => i > first && !line.startsWith("|"));
  return lines.slice(first + 2, end < 0 ? undefined : end).map((line) =>
    line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim()),
  );
}

export function approvedPackages(conventions: string, language: string) {
  return table(conventions, new RegExp("^#### .+ \\(\x60" + language + "\x60\\)", "m")).map(
    ([name, purpose, scopes]) => ({
      name: name.replaceAll("`", ""),
      purpose,
      scopes: scopes.split(",").map((scope) => scope.trim()),
    }),
  );
}

export function applicablePackages(
  conventions: string,
  language: string,
  name: string,
  llm: boolean,
) {
  return approvedPackages(conventions, language).filter(({ scopes }) =>
    scopes.some((scope) => scope === "all" || scope === name || (scope === "--llm" && llm)),
  );
}

export function within(dir: string, path: string) {
  const remainder = relative(resolve(dir), resolve(path));
  return remainder !== ".." && !remainder.startsWith(".." + sep);
}

export function isDirectory(file: string) {
  return existsSync(file) && statSync(file).isDirectory();
}

export const tick = (value: unknown) => "`" + value + "`";
export const exactVersion = /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/;

export function run(bin: string, args: string[], cwd = process.cwd()) {
  return execFileSync(resolve("node_modules/.bin", bin), args, {
    cwd,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function main(action: () => void) {
  try {
    action();
  } catch (error) {
    if (error instanceof Error) {
      console.error(error.message);
      if ("stderr" in error && error.stderr) console.error(String(error.stderr).trim());
    } else {
      console.error(error);
    }
    process.exitCode = 1;
  }
}
