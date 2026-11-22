import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  applicablePackages,
  exactVersion,
  files,
  json,
  main,
  manifestFile,
  operations,
  read,
  run,
  specsDir,
  yaml,
  type Document,
} from "./contracts.js";

const languages = ["ts", "python", "go"];
const manifests = ["package.json", "pyproject.toml", "go.mod", ".template.json"];
type Item = { name: string; language: string };

function tools() {
  const manifest = yaml(manifestFile);
  const entries: Item[] = [{ name: "_template", language: "ts" }];
  for (const [name, service] of Object.entries<Document>(manifest.services)) {
    if (!manifests.some((file) => existsSync(join("services", name, file)))) continue;
    const spec = join(specsDir, name + ".yaml");
    if (!existsSync(spec) || yaml(spec)["x-rex-service"]?.kind !== "tool") continue;
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name) || !languages.includes(service.language)) {
      throw new Error(manifestFile + ": invalid tool name or language for " + name);
    }
    entries.push({ name, language: service.language });
  }
  return entries;
}

function changedFiles(base: string | undefined) {
  if (!base || /^0+$/.test(base)) return undefined;
  if (!/^[a-f\d]{40}$/.test(base)) throw new Error("Expected a base commit SHA");
  return execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", base, "HEAD", "--"], {
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
}

function selectedTools(base: string | undefined) {
  const all = tools();
  const changed = changedFiles(base);
  if (
    !changed ||
    changed.some((path) =>
      /^(?:packages\/contracts\/|services\/_template(?:[/-]|$)|\.github\/workflows\/|scripts\/(?:lib\/(?:tool-ci|tool-template|new-tool|check-repo)\.ts|new-tool$|tool-ci$|portability-tool$|offline-tool$)|\.nvmrc$|docs\/conventions\.md$)/.test(
        path,
      ),
    )
  ) {
    return all;
  }
  return all.filter(({ name }) =>
    changed.some((path) => path.startsWith("services/" + name + "/")),
  );
}

function checkManifest(name: string) {
  const selected = tools().find((item) => item.name === name);
  if (selected?.language !== "ts") throw new Error("No runnable TypeScript tool " + name);
  const path = join("services", name, "package.json");
  const pkg = json(path);
  const config = yaml(manifestFile).services[name];
  const llm =
    name === "_template" ||
    config?.llm === true ||
    (name !== "_template" &&
      operations(yaml(join(specsDir, name + ".yaml"))).some(({ op }) =>
        ["optional", "required"].includes(op["x-rex-limits"]?.llm),
      ));
  const approved = new Set(
    applicablePackages(read("docs/conventions.md"), "ts", name, llm).map(({ name }) => name),
  );
  for (const section of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "devDependencies",
  ]) {
    for (const [dep, version] of Object.entries(pkg[section] ?? {})) {
      if (typeof version !== "string" || !exactVersion.test(version) || dep.startsWith("@rex/")) {
        throw new Error(path + ": " + dep + " must use an exact public npm version");
      }
      if (section !== "devDependencies" && !approved.has(dep)) {
        throw new Error(path + ": runtime dependency " + dep + " is unapproved");
      }
    }
  }
  const lock = join("services", name, "package-lock.json");
  if (!existsSync(lock)) throw new Error(lock + ": missing lockfile");
  console.log(path + ": exact pins and approved runtime packages");
}

const ignored = [
  "**/node_modules/**",
  "**/contract/**",
  "**/generated/**",
  "**/migrations/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/.venv/**",
  "**/vendor/**",
  "**/test/**",
  "**/tests/**",
  "**/*.test.*",
  "**/*.spec.*",
  "**/test_*.py",
  "**/*_test.go",
];
const ignoredParts = new Set([
  "node_modules",
  "contract",
  "generated",
  "migrations",
  "dist",
  "build",
  "coverage",
  ".venv",
  "vendor",
  "test",
  "tests",
]);
const normalize = (path: string) => (isAbsolute(path) ? relative(process.cwd(), path) : path);

function duplicates(base?: string) {
  const all = tools();
  const active = new Set(selectedTools(base).map(({ name }) => "services/" + name));
  const roots = [
    ...all.map(({ name }) => "services/" + name),
    ...["apps", "packages"].flatMap((parent) =>
      existsSync(parent)
        ? readdirSync(parent, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && entry.name !== "contracts")
            .map((entry) => join(parent, entry.name))
        : [],
    ),
  ];
  const changed = changedFiles(base);
  for (const root of roots.filter((path) => !path.startsWith("services/"))) {
    if (!changed || changed.some((path) => path.startsWith(root + "/"))) active.add(root);
  }
  if (!active.size) {
    console.log("No source folders changed");
    return;
  }

  const owner = (file: string) => roots.find((root) => file.startsWith(root + "/"));
  const copied = new Set<string>();
  for (const { name } of all) {
    const root = "services/" + name;
    const path = root + "/.template.json";
    if (existsSync(path)) {
      for (const [file, tracking] of Object.entries<Document>(json(path).files ?? {})) {
        if (!tracking.owned) copied.add(root + "/" + file);
      }
    }
  }
  const temp = mkdtempSync(join(tmpdir(), "rex-jscpd-"));
  const issues = new Set<string>();
  try {
    run("jscpd", [
      "--absolute",
      "--reporters",
      "json",
      "--output",
      temp,
      "--min-tokens",
      "50",
      "--min-lines",
      "10",
      "--mode",
      "weak",
      "--format",
      "typescript,javascript,tsx,jsx,python,go",
      "--ignore",
      ignored.join(","),
      ...roots.map((root) => resolve(root)),
    ]);
    const report = json(join(temp, "jscpd-report.json"));
    const duplicated = new Map<string, Set<number>>();
    for (const clone of report.duplicates) {
      const first = normalize(clone.firstFile.name);
      const second = normalize(clone.secondFile.name);
      const left = owner(first);
      const right = owner(second);
      if (!left || !right || !(active.has(left) || active.has(right))) continue;
      const label =
        first + ":" + clone.firstFile.start + " and " + second + ":" + clone.secondFile.start;
      if (left === right) {
        issues.add(label + ": " + clone.tokens + "-token duplicate in " + left);
        for (const [path, range] of [
          [first, clone.firstFile],
          [second, clone.secondFile],
        ]) {
          const lines = duplicated.get(path) ?? new Set<number>();
          for (let line = range.start; line <= range.end; line++) lines.add(line);
          duplicated.set(path, lines);
        }
      } else if (
        left.startsWith("services/") &&
        right.startsWith("services/") &&
        left !== "services/_template" &&
        right !== "services/_template" &&
        !copied.has(first) &&
        !copied.has(second)
      ) {
        issues.add(label + ": duplicate across tools (" + clone.tokens + " tokens)");
      }
    }
    for (const root of active) {
      const source = files(root).filter(
        (path) =>
          /\.(?:[jt]sx?|py|go)$/.test(path) &&
          !path.split("/").some((part) => ignoredParts.has(part)) &&
          !/(?:\.(?:test|spec)\.[jt]sx?$|(?:^|\/)test_[^/]+\.py$|_test\.go$)/.test(path),
      );
      const total = source.reduce((sum, path) => sum + read(path).trimEnd().split("\n").length, 0);
      const lines = source.reduce((sum, path) => sum + (duplicated.get(path)?.size ?? 0), 0);
      const percent = total ? (lines * 100) / total : 0;
      if (percent > 3) issues.add(root + ": " + percent.toFixed(2) + "% duplication exceeds 3%");
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  if (issues.size) throw new Error([...issues].join("\n"));
  console.log("Duplication checks passed (" + active.size + " changed folders)");
}

main(() => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { base: { type: "string" } },
  });
  switch (positionals[0]) {
    case "matrix":
      console.log(JSON.stringify({ include: selectedTools(values.base) }));
      break;
    case "manifest":
      checkManifest(positionals[1]);
      break;
    case "duplicates":
      duplicates(values.base);
      break;
    default:
      throw new Error("Usage: scripts/tool-ci matrix|duplicates [--base <sha>] or manifest <tool>");
  }
});
