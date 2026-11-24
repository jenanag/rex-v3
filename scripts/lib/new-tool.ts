import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parseDocument } from "yaml";
import {
  contractsDir,
  files,
  json,
  main,
  manifestFile,
  operations,
  policyFile,
  read,
  serviceDoc,
  specsDir,
  toolDir,
  yaml,
  type Document,
} from "./contracts.js";
import {
  hash,
  recipe,
  renderEnv,
  renderFiles,
  templateDir,
  templateVersion,
  tracking,
  type Recipe,
  type Tracking,
} from "./tool-template.js";

const root = process.cwd();
const lockFile = "package-lock.json";

function write(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function scratch(action: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "rex-tool-"));
  try {
    action(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function lock(dir: string, name: string, baseline = join(templateDir, lockFile)) {
  const data = json(baseline);
  data.name = name;
  data.packages[""].name = name;
  write(join(dir, lockFile), JSON.stringify(data, null, 2) + "\n");
  execFileSync(
    "npm",
    ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: dir, stdio: "inherit" },
  );
}

function renderState(
  options: Recipe,
  generated: Map<string, string>,
  previous?: Tracking,
): Tracking {
  return {
    template: templateDir,
    version: templateVersion,
    options: { llm: options.llm, example: options.example },
    files: Object.fromEntries(
      [...generated]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([path, content]) => [
          path,
          previous?.files[path]?.owned ? previous.files[path] : { sha256: hash(content) },
        ]),
    ),
  };
}

function writeState(dir: string, state: Tracking) {
  write(join(dir, ".template.json"), JSON.stringify(state, null, 2) + "\n");
}

function execute(script: string, cwd: string, ...args: string[]) {
  execFileSync(
    process.execPath,
    [
      resolve(root, "node_modules/tsx/dist/cli.mjs"),
      resolve(root, "scripts/lib", script + ".ts"),
      ...args,
    ],
    { cwd, stdio: "inherit" },
  );
}

function validateName(name: string) {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)) throw new Error("Use a kebab-case tool name");
}

function hasLanguageDecision(name: string, language: string) {
  return files("docs/adr", ".md").some((file) => {
    const decision = read(file);
    return (
      /^- \*\*Status:\*\* Accepted\b/m.test(decision) &&
      decision.includes("- **Tool:** `" + name + "`") &&
      decision.includes("- **Language:** `" + language + "`")
    );
  });
}

function serviceStub(name: string, source: string) {
  return [
    "# " + name,
    "",
    "- **Kind:** tool",
    "- **Phase:** 1",
    "- **Contract:** [OpenAPI](../../" + source + ")",
    "",
    "## Purpose",
    "",
    "A standalone example that echoes the supplied text.",
    "",
    ...["endpoints", "cache", "limits", "shared", "deps"].flatMap((kind) => [
      "## " + kind[0].toUpperCase() + kind.slice(1),
      "",
      "<!-- GENERATED:" + kind + " START -->",
      "<!-- GENERATED:" + kind + " END -->",
      "",
    ]),
  ].join("\n");
}

function scaffold(name: string, llm: boolean) {
  const dir = toolDir(name);
  const specFile = join(specsDir, name + ".yaml");
  const manifest = yaml(manifestFile);
  const old = manifest.services[name];
  const example = !existsSync(specFile);
  if (
    existsSync(join(dir, "package.json")) ||
    files(dir).some(
      (path) =>
        !/^contract\//.test(relative(dir, path)) &&
        !["AGENTS.md", ".DS_Store"].includes(relative(dir, path)),
    )
  ) {
    throw new Error(
      dir + ": existing files prevent scaffolding. Use --upgrade for scaffolded tools.",
    );
  }
  if ((old && example) || (existsSync(serviceDoc(name)) && example)) {
    throw new Error(
      name + ": reserved for a tool. Write its OpenAPI contract and language ADR first.",
    );
  }
  if (!example && !hasLanguageDecision(name, "ts")) {
    throw new Error(name + ": requires an Accepted language ADR with Tool and Language fields");
  }

  const templateSpec = yaml("packages/contracts/openapi/templates/echo.yaml");
  const spec = example ? templateSpec : yaml(specFile);
  if (!example && (spec["x-rex-service"]?.kind !== "tool" || spec["x-rex-service"].name !== name)) {
    throw new Error(specFile + ": expected a tool spec matching its filename");
  }
  const ownsLlm = operations(spec).some(({ op }) =>
    ["optional", "required"].includes(op["x-rex-limits"]?.llm),
  );
  if (!example && ownsLlm !== llm) {
    throw new Error(
      name + (ownsLlm ? ": the spec requires --llm" : ": the spec does not declare LLM use"),
    );
  }
  if (operations(spec).some(({ op }) => !/^[a-z][a-zA-Z0-9]*$/.test(op.operationId))) {
    throw new Error(specFile + ": every operation must have a camelCase operationId");
  }
  const options = { name, example, llm };
  const generated = renderFiles(options);

  scratch((staging) => {
    for (const path of [
      contractsDir,
      "docs",
      "redocly.yaml",
      join(templateDir, "AGENTS.md.tmpl"),
    ]) {
      cpSync(path, join(staging, path), { recursive: true, verbatimSymlinks: true });
    }
    symlinkSync(join(root, "node_modules"), join(staging, "node_modules"), "dir");
    const stageTool = join(staging, dir);
    if (existsSync(dir))
      cpSync(dir, stageTool, {
        recursive: true,
        filter: (path) => basename(path) !== "node_modules",
      });
    const registry = parseDocument(read(manifestFile));
    registry.setIn(["services", name], {
      ...old,
      language: "ts",
      ...(example ? { example: true, llm } : {}),
      files: old?.files ?? [
        { target: "contract/openapi.yaml", from: relative(contractsDir, specFile), how: "bundle" },
        { how: "types", from: "./contract/openapi.yaml", fromPhase: 1 },
      ],
    });
    write(join(staging, manifestFile), String(registry));
    const apiRegistry = parseDocument(read("redocly.yaml"));
    apiRegistry.setIn(["apis", name], { root: specFile });
    write(join(staging, "redocly.yaml"), String(apiRegistry));
    if (example) {
      const source = read("packages/contracts/openapi/templates/echo.yaml")
        .replace("name: echo-template", "name: " + name)
        .replace("title: REx tool template", "title: " + name);
      write(join(staging, specFile), source);
      write(join(staging, serviceDoc(name)), serviceStub(name, specFile));
    } else if (!existsSync(serviceDoc(name))) {
      throw new Error(serviceDoc(name) + ": add the tool's service doc before scaffolding");
    }
    const policy = parseDocument(read(policyFile));
    if (!policy.hasIn(["tools", name])) {
      policy.setIn(["tools", name], {
        keyVersion: 1,
        operations: Object.fromEntries(
          operations(spec).map(({ op }) => [op.operationId, { cacheable: false }]),
        ),
      });
      write(join(staging, policyFile), String(policy));
    }
    if (!example) {
      generated.set(
        "src/handlers/index.ts",
        [
          'import type { Handlers } from "../app.js";',
          'import { ToolProblem } from "../errors.js";',
          "",
          "export const handlers: Handlers = {",
          ...operations(spec).map(
            ({ op }) =>
              "  " +
              op.operationId +
              ': async () => { throw new ToolProblem(501, "not_implemented", "Operation is not implemented"); },',
          ),
          "};",
          "",
        ].join("\n"),
      );
      generated.set("src/domain/.gitkeep", "");
    }
    for (const [path, content] of generated) write(join(stageTool, path), content);
    lock(stageTool, name);
    generated.set(lockFile, read(join(stageTool, lockFile)));
    const state = renderState(options, generated);
    if (!example) {
      state.files["src/handlers/index.ts"].owned = true;
      state.files["src/domain/.gitkeep"].owned = true;
    }
    writeState(stageTool, state);
    execute("vendor-contracts", staging, "--service", name);
    execute("gen-docs", staging, "--service", name);

    for (const path of [manifestFile, policyFile, specFile, serviceDoc(name), "redocly.yaml"]) {
      const staged = join(staging, path);
      if (!existsSync(path) || read(path) !== read(staged)) write(path, read(staged));
    }
    cpSync(stageTool, dir, { recursive: true });
  });
  console.log("Scaffolded " + name + " in " + dir);
}

function renderToolEnv(name: string, check: boolean) {
  validateName(name);
  const { llm } = recipe(name, tracking(name));
  const dir = toolDir(name);
  const load = createRequire(import.meta.url);
  const properties = load(resolve(dir, "src/env.ts")).envProperties;
  const providerProperties = llm ? load(resolve(dir, "src/llm/env.ts")).llmEnvProperties : {};
  const overlay = resolve(dir, "src/tool-env.ts");
  const toolProperties = existsSync(overlay) ? load(overlay).toolEnvProperties : undefined;
  const { example, table } = renderEnv(name, llm, {
    properties,
    providerProperties,
    toolProperties,
  });
  const envFile = join(dir, ".env.example");
  const readmeFile = join(dir, "README.md");
  const readme = read(readmeFile);
  const block = /(<!-- GENERATED:env START -->\n)[\s\S]*?(<!-- GENERATED:env END -->)/;
  if (!block.test(readme)) throw new Error(readmeFile + ": missing generated env block");
  const expected = readme.replace(block, (_, start, end) => start + table + "\n" + end);
  for (const [path, value] of [
    [envFile, example],
    [readmeFile, expected],
  ]) {
    if (existsSync(path) && read(path) === value) continue;
    if (check) throw new Error(path + ": generated environment docs are out of date");
    write(path, value);
  }
  console.log("Tool environment docs in sync (" + name + ")");
}

function drift(name: string) {
  const state = tracking(name);
  const dir = toolDir(name);
  const rendered = renderFiles(recipe(name, state));
  const result: string[] = [];
  if (state.version !== templateVersion)
    result.push(join(dir, ".template.json") + ": template version changed");
  for (const path of new Set([...rendered.keys(), ...Object.keys(state.files)])) {
    const file = join(dir, path);
    const tracked = state.files[path];
    if (tracked?.owned) continue;
    const content = existsSync(file) ? read(file) : undefined;
    if (
      !tracked ||
      content === undefined ||
      hash(content) !== tracked.sha256 ||
      (path !== lockFile && rendered.get(path) !== content)
    )
      result.push(file + ": template drift");
  }
  if (!state.files[lockFile])
    result.push(join(dir, lockFile) + ": lockfile missing from template metadata");
  return result;
}

function upgrade(name: string) {
  const state = tracking(name);
  const options = recipe(name, state);
  const dir = toolDir(name);
  const generated = renderFiles(options);
  for (const [path, entry] of Object.entries(state.files)) {
    if (!entry.owned) continue;
    generated.delete(path);
  }
  scratch((temporary) => {
    const manifest = join(dir, "package.json");
    const packageData = generated.get("package.json") ?? read(manifest);
    if (!state.files[lockFile]?.owned) {
      write(join(temporary, "package.json"), packageData);
      lock(temporary, name, existsSync(join(dir, lockFile)) ? join(dir, lockFile) : undefined);
      generated.set(lockFile, read(join(temporary, lockFile)));
    }
    const next = renderState(options, generated, state);
    for (const [path, entry] of Object.entries(state.files)) {
      if (entry.owned) next.files[path] = entry;
      else if (!generated.has(path) && existsSync(join(dir, path))) {
        console.log("Removed " + join(dir, path));
        rmSync(join(dir, path));
      }
    }
    for (const [path, content] of generated) {
      const target = join(dir, path);
      if (existsSync(target) && read(target) === content) continue;
      const staged = join(temporary, path);
      write(staged, content);
      const diff = spawnSync("diff", ["-u", existsSync(target) ? target : "/dev/null", staged], {
        encoding: "utf8",
      });
      if (diff.status !== 1) throw new Error("Could not show template diff for " + target);
      process.stdout.write(diff.stdout);
      write(target, content);
    }
    writeState(dir, next);
  });
  console.log("Upgraded " + name + " to template " + templateVersion);
}

main(() => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      lang: { type: "string" },
      llm: { type: "boolean" },
      check: { type: "boolean" },
      upgrade: { type: "string" },
      "render-template-docs": { type: "boolean" },
      "render-tool-env": { type: "string" },
    },
  });
  if (values["render-tool-env"] !== undefined) {
    if (
      values.lang ||
      values.llm ||
      values.upgrade ||
      values["render-template-docs"] ||
      positionals.length
    )
      throw new Error("Use --render-tool-env <tool> [--check]");
    renderToolEnv(values["render-tool-env"], values.check === true);
    return;
  }
  if (values["render-template-docs"]) {
    const rendered = renderFiles({ name: "rex-tool-template", llm: true, example: true });
    for (const path of [".env.example", "README.md"])
      write(join(templateDir, path), rendered.get(path)!);
    return;
  }
  if (values.check || values.upgrade) {
    if (
      values.lang ||
      values.llm ||
      (values.upgrade && (values.check || positionals.length)) ||
      positionals.length > 1
    ) {
      throw new Error("Use --check [<tool>] or --upgrade <tool>");
    }
    if (values.upgrade) {
      validateName(values.upgrade);
      upgrade(values.upgrade);
      return;
    }
    const manifest = yaml(manifestFile);
    const names = positionals.length
      ? positionals
      : Object.keys(manifest.services).filter(
          (name) =>
            manifest.services[name].language &&
            (existsSync(join(toolDir(name), ".template.json")) ||
              existsSync(join(toolDir(name), "package.json"))),
        );
    const problems = names.flatMap((name) => {
      validateName(name);
      return drift(name);
    });
    if (problems.length)
      throw new Error(problems.join("\n") + "\nRun scripts/new-tool --upgrade <tool>.");
    console.log("Tool templates in sync (" + names.length + ")");
    return;
  }
  if (positionals.length !== 1)
    throw new Error("Usage: scripts/new-tool <name> [--lang ts|python|go] [--llm]");
  const [name] = positionals;
  validateName(name);
  const language = values.lang ?? "ts";
  if (language === "python" || language === "go")
    throw new Error("run the " + language + " bring-up first");
  if (language !== "ts") throw new Error("Unsupported tool language: " + language);
  scaffold(name, values.llm ?? false);
});
