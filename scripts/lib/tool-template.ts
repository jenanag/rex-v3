import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, relative, join } from "node:path";
import { envProperties } from "../../services/_template/src/env.js";
import { llmEnvProperties } from "../../services/_template/src/llm/env.js";
import { files, json, read, yaml, manifestFile } from "./contracts.js";

export const templateDir = "services/_template";
export const templateVersion = json(join(templateDir, "template.json")).version as number;
const templateName = "rex-tool-template";
const llmPackages = ["openai", "@anthropic-ai/sdk", "@google/genai"];

export type Recipe = { name: string; llm: boolean; example: boolean };
export type Tracking = {
  template: string;
  version: number;
  options: { llm: boolean; example: boolean };
  files: Record<string, { sha256: string; owned?: boolean }>;
};

export const hash = (content: string) => createHash("sha256").update(content).digest("hex");

type EnvProperties = Record<string, { description: string; default?: string | number | boolean }>;

export function renderEnv(
  name: string,
  llm: boolean,
  {
    properties = envProperties,
    providerProperties = llmEnvProperties,
    toolProperties,
  }: {
    properties?: EnvProperties;
    providerProperties?: EnvProperties;
    toolProperties?: EnvProperties;
  } = {},
) {
  const env = Object.entries({
    ...properties,
    ...toolProperties,
    ...(llm ? providerProperties : {}),
  });
  const fallback = (key: string, spec: EnvProperties[string]) =>
    key === "SERVICE_NAME" ? name : spec.default;
  return {
    example:
      "# GENERATED - DO NOT EDIT. Source: src/env.ts" +
      (toolProperties ? ", src/tool-env.ts" : "") +
      " and the optional src/llm/env.ts.\n" +
      env
        .map(
          ([key, spec]) =>
            "# " +
            spec.description +
            "\n" +
            (fallback(key, spec) === undefined ? "# " : "") +
            key +
            "=" +
            (fallback(key, spec) ?? ""),
        )
        .join("\n\n") +
      "\n",
    table: [
      "| Variable | Default | Purpose |",
      "|---|---|---|",
      ...env.map(
        ([key, spec]) =>
          "| `" + key + "` | " + (fallback(key, spec) ?? "unset") + " | " + spec.description + " |",
      ),
    ].join("\n"),
  };
}

export function renderFiles({ name, llm, example }: Recipe) {
  const rendered = new Map<string, string>();
  for (const file of files(templateDir)) {
    const path = relative(templateDir, file);
    if (
      !/^(?:src\/|test\/|scripts\/|(?:package\.json|README\.md|Dockerfile|tsconfig(?:\.build)?\.json|eslint\.config\.js|\.dependency-cruiser\.cjs|\.dockerignore|\.prettierrc)$)/.test(
        path,
      ) ||
      /^(?:\.env|\.DS_Store)/.test(basename(path))
    )
      continue;
    if (!llm && /^(?:src\/llm\/|test\/fixtures\/llm\/|test\/llm\.test\.ts$)/.test(path)) continue;
    if (
      !example &&
      /^(?:src\/domain\/echo\.ts$|src\/handlers\/index\.ts$|test\/echo\.test\.ts$)/.test(path)
    )
      continue;
    let content = read(file);
    if (path === "package.json") {
      const manifest = JSON.parse(content);
      manifest.name = name;
      if (!llm) for (const dep of llmPackages) delete manifest.dependencies[dep];
      content = JSON.stringify(manifest, null, 2) + "\n";
    } else if (path === "src/env.ts") {
      content = content.replace(JSON.stringify(templateName), JSON.stringify(name));
    } else if (path === "README.md") {
      content = content.replaceAll(templateName, name);
      if (!example) content = content.replace(/^curl[^\n]+\/v1\/echoes[^\n]*\n/m, "");
      if (!llm) content = content.replace(/\nThe LLM adapter[\s\S]*$/, "");
      content = content.replace(
        /(<!-- GENERATED:env START -->\n)[\s\S]*?(<!-- GENERATED:env END -->)/,
        (_, start, end) => start + renderEnv(name, llm).table + "\n" + end,
      );
    }
    rendered.set(path, content);
  }
  rendered.set(".env.example", renderEnv(name, llm).example);
  return rendered;
}

export function tracking(name: string): Tracking {
  const dir = join("services", name);
  const file = join(dir, ".template.json");
  if (!existsSync(file)) throw new Error(file + ": missing template metadata");
  const metadata = json(file) as Tracking;
  if (
    metadata.template !== templateDir ||
    !metadata.options ||
    !metadata.files ||
    Object.keys(metadata.files).some(
      (path) => !/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\\]+$/.test(path),
    )
  ) {
    throw new Error(file + ": invalid template metadata");
  }
  return metadata;
}

export function recipe(name: string, metadata: Tracking): Recipe {
  const service = yaml(manifestFile).services[name];
  if (service?.language !== "ts" || Boolean(service.example) !== metadata.options.example) {
    throw new Error("services/" + name + "/.template.json: recipe disagrees with vendoring.yaml");
  }
  return { name, ...metadata.options };
}
