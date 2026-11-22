import { existsSync, lstatSync, realpathSync, readdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  applicablePackages,
  approvedPackages,
  contractsDir,
  exactVersion,
  files,
  isDirectory,
  manifestFile,
  nodes,
  operations,
  read,
  serviceDoc,
  table,
  toolDir,
  within,
  yaml,
  json,
  type Document,
} from "./contracts.js";
import type { Report } from "./check-specs.js";

type Spec = { file: string; spec: Document; name: string; kind: string };
const packageSections = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];
const manifestByLanguage = { ts: "package.json", python: "pyproject.toml", go: "go.mod" };
const lockByLanguage = { ts: "package-lock.json", python: "uv.lock", go: "go.sum" };
type Language = keyof typeof manifestByLanguage;
const conventionsFile = "docs/conventions.md";
const architectureFile = "docs/architecture.md";
const roadmapFile = "docs/roadmap.md";
const externalNames = ["content-extractor", "sitemap-extractor", "data-aggregator", "seo-auditor"];
const fetchPackages = new Set([
  "axios",
  "got",
  "node-fetch",
  "undici",
  "playwright",
  "puppeteer",
  "requests",
  "httpx",
  "aiohttp",
  "urllib3",
  "github.com/go-resty/resty/v2",
  "github.com/gocolly/colly/v2",
]);

function packagesOf(manifest: Document, sections = packageSections) {
  return sections.flatMap((section) => Object.entries<string>(manifest[section] ?? {}));
}

function pythonDependencies(source: string) {
  const dependencies: { name: string; spec: string; runtime: boolean }[] = [];
  // PEP 508 strings in PEP 621 / uv dependency arrays, including optional and development groups.
  let section = "";
  for (const line of source.split(/\n(?=\s*\[[^\n]+\]\s*(?:#.*)?$)/m)) {
    section = /^\s*\[([^\]]+)\]/.exec(line)?.[1] ?? section;
    if (
      ![
        "project",
        "project.optional-dependencies",
        "dependency-groups",
        "tool.uv",
        "build-system",
      ].includes(section)
    )
      continue;
    const arrays =
      section === "project" || section === "tool.uv" || section === "build-system"
        ? line.matchAll(
            /^(?:dependencies|dev-dependencies|requires)\s*=\s*\[((?:"[^"]*"|'[^']*'|[^"'\]])*)\]/gm,
          )
        : line.matchAll(/^\s*[\w.-]+\s*=\s*\[((?:"[^"]*"|'[^']*'|[^"'\]])*)\]/gm);
    for (const [, body] of arrays) {
      for (const [, double, single] of body
        .replace(/(?:^|\n)\s*#[^\n]*/g, "")
        .matchAll(/"([^"]*)"|'([^']*)'/g)) {
        const value = double ?? single;
        if (value)
          dependencies.push({
            name: value.match(/^[\w.-]+/)?.[0] ?? "",
            spec: value,
            runtime: section.startsWith("project"),
          });
      }
    }
  }
  return dependencies;
}

function goDependencies(source: string) {
  const result: { name: string; spec: string; runtime: boolean }[] = [];
  let requires = false;
  for (const line of source.split("\n").map((text) => text.trim())) {
    if (/^require\s*\($/.test(line)) {
      requires = true;
      continue;
    }
    if (line === ")") {
      requires = false;
      continue;
    }
    if (!(requires || /^require\s+/.test(line))) continue;
    const [name, spec] = line.replace(/^require\s+/, "").split(/\s+/);
    if (name) result.push({ name, spec, runtime: !/\/\/\s*indirect\b/.test(line) });
  }
  return result;
}

function checkImports(file: string, dir: string, report: Report) {
  if (lstatSync(file).isSymbolicLink()) {
    if (!existsSync(file) || !within(realpathSync(dir), realpathSync(file))) {
      report("portability", file, "symlink is broken or resolves outside " + dir);
    }
    return;
  }
  if (
    relative(dir, file).startsWith("contract/") ||
    !/\.(?:[cm]?[jt]sx?|py|go|json|toml|ya?ml)$|\/Dockerfile$/.test(file)
  )
    return;
  const body = read(file);
  const matches = [
    ...body.matchAll(
      /\b(?:from\s*|import\s*(?:\(\s*)?|require(?:\.resolve)?\s*\(\s*)["']([^"']+)["']/g,
    ),
    ...body.matchAll(/["']((?:\.\.\/|file:\.\.\/)[^"'\n]+)["']/g),
  ];
  for (const [, source] of matches) {
    const path = source.replace(/^file:/, "");
    if (
      source.startsWith("@rex/") ||
      isAbsolute(path) ||
      (path.startsWith(".") && !within(dir, resolve(dirname(file), path)))
    ) {
      report("portability", file, "reference escapes the tool: " + source);
    }
  }
  if (file.endsWith("Dockerfile")) {
    for (const [, source] of body.matchAll(/^\s*(?:COPY|ADD)\s+(\.\.\S*|https?:\/\/\S+)/gim)) {
      report("portability", file, "Docker build input is outside the tool: " + source);
    }
  }
  if (
    file.endsWith(".py") &&
    (/\bsys\.path\b/.test(body) ||
      [...body.matchAll(/^\s*from\s+(\.{2,})(?:[\w.]+)?\s+import\b/gm)].some(([, dots]) => {
        const depth = relative(dir, dirname(file)).split("/").filter(Boolean).length;
        return dots.length > depth;
      }))
  ) {
    report("portability", file, "Python import resolves outside the tool package");
  }
}

function checkTool(
  name: string,
  language: Language,
  llm: boolean,
  conventions: string,
  report: Report,
) {
  const dir = toolDir(name);
  const file = join(dir, manifestByLanguage[language]);
  const approved = new Set(
    applicablePackages(conventions, language, name, llm).map((pkg) => pkg.name),
  );
  if (existsSync(file)) {
    const source = read(file);
    const dependencies =
      language === "ts"
        ? packagesOf(json(file)).map(([name, spec]) => ({
            name,
            spec,
            runtime: packagesOf(json(file), [
              "dependencies",
              "peerDependencies",
              "optionalDependencies",
            ]).some(([pkg]) => pkg === name),
          }))
        : language === "python"
          ? pythonDependencies(source)
          : goDependencies(source);

    if (!existsSync(join(dir, lockByLanguage[language])))
      report("portability", file, "missing " + lockByLanguage[language]);
    if (
      language === "python" &&
      (/\b(?:path|git|editable|url)\s*=/.test(source) || /\[tool\.uv\.workspace\]/.test(source))
    ) {
      report("portability", file, "path, git, editable or workspace dependency source");
    }
    if (language === "go" && /^\s*replace\b/m.test(source))
      report("portability", file, "go.mod has a replace directive");

    for (const { name: dependency, spec, runtime } of dependencies) {
      const exact =
        language === "ts"
          ? exactVersion.test(spec)
          : language === "python"
            ? /^[\w.-]+(?:\[[\w., -]+\])?\s*==\s*\d[\w.+!-]*(?:\s*;.*)?$/.test(spec)
            : /^v\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/.test(spec) &&
              /^[^/]+\.[^/]+\/.+/.test(dependency);
      if (!exact || dependency.startsWith("@rex/"))
        report("portability", file, dependency + " is not a public exact dependency: " + spec);
      if (runtime && !approved.has(dependency))
        report("approved-dependencies", file, dependency + " is not approved for " + name);
      if (runtime && fetchPackages.has(dependency))
        report("external-callers", file, dependency + " performs outbound fetches");
    }
  } else if (
    files(dir).some(
      (path) =>
        !within(join(dir, "contract"), path) &&
        !["AGENTS.md", ".DS_Store"].includes(basename(path)),
    )
  ) {
    report("portability", file, "scaffolded tool is missing its language manifest");
  }

  const doc = serviceDoc(name);
  const mentions = read(doc).matchAll(/(?:^|\n)- `((?:@[^/]+\/)?[a-z][\w/-]*)`: /g);
  const known = new Set(approvedPackages(conventions, language).map((pkg) => pkg.name));
  for (const [, pkg] of mentions) {
    if (
      (known.has(pkg) || /^(?:@|axios$|undici$|got$|node-fetch$)/.test(pkg)) &&
      !approved.has(pkg)
    ) {
      report("approved-dependencies", doc, pkg + " is not approved for " + name);
    }
  }
  for (const path of files(dir)) checkImports(path, dir, report);
}

function checkVendoring(all: Spec[], manifest: Document, report: Report) {
  const outputRoots = { services: "contract", handoff: "handoff" };
  const sourceSpecs = new Map(all.map((entry) => [entry.name, entry]));
  const conventions = read(conventionsFile);
  const architecture = read(architectureFile);
  const adr = read("docs/adr/0024-per-tool-language.md");
  const languages = { ts: "TypeScript", python: "Python", go: "Go" };
  const adrTools = new Set(
    [...adr.matchAll(/^\| `([\w-]+)` \| \d+ \|/gm)].map((match) => match[1]),
  );

  for (const [language, title] of Object.entries(languages)) {
    const data = manifest.languages?.[language];
    const template = language === "ts" ? "services/_template" : "services/_template-" + language;
    if (
      !data ||
      data.template !== template ||
      !manifest.generators?.[data.types?.how] ||
      !data.types?.target ||
      !approvedPackages(conventions, language).length ||
      !architecture
        .slice(
          architecture.indexOf("### Per-service layouts"),
          architecture.indexOf("## Service map"),
        )
        .includes(title) ||
      !new RegExp("^\\| Rule \\|.*" + title + " \\(\x60" + language + "\x60\\)", "m").test(adr)
    ) {
      report(
        "tool-language",
        manifestFile,
        language + " needs its template, generator, dependencies, layout and ADR column",
      );
    }
  }
  for (const language of Object.keys(manifest.languages ?? {})) {
    if (!Object.hasOwn(languages, language))
      report("tool-language", manifestFile, "unknown language " + language);
  }
  for (const [name, kind] of table(architecture, /^\| Service \| Kind \| Phase /m)) {
    if (kind === "tool" && name && !adrTools.has(name)) {
      report("tool-language", architectureFile, name + " is missing from ADR 0024");
    }
  }

  const targets = new Set<string>();
  const llmSwitches: readonly string[] =
    conventions
      .match(/Template switches per tool: `--llm` for ([^.]+)\./)?.[1]
      .match(/[a-z]+(?:-[a-z]+)+/g) ?? [];
  for (const [group, root] of Object.entries(outputRoots)) {
    for (const [name, config] of Object.entries<Document>(manifest[group] ?? {})) {
      const owner = sourceSpecs.get(name);
      const tool = owner?.kind === "tool";
      const language = config.language as Language;
      if (group === "services" && tool) {
        if (!Object.hasOwn(languages, language))
          report("tool-language", manifestFile, name + ": invalid or missing language " + language);
        const ops = operations(owner.spec);
        const example =
          config.example === true &&
          ops.length === 1 &&
          ops[0].op.operationId === "echoText" &&
          ops[0].path === "/v1/echoes";
        if (!example && !adrTools.has(name))
          report("tool-language", manifestFile, name + " is missing from ADR 0024");
        if (Object.hasOwn(languages, language)) {
          const llm = operations(owner.spec).some(({ op }) =>
            ["required", "optional"].includes(op["x-rex-limits"]?.llm),
          );
          if (!example && llm !== llmSwitches.includes(name)) {
            report(
              "limits",
              owner.file,
              name + " disagrees with the --llm switches in " + conventionsFile,
            );
          }
          checkTool(name, language, llm || (example && config.llm === true), conventions, report);
        }
      } else if (language !== undefined) {
        report("tool-language", manifestFile, name + ": language is set only for tools");
      }

      const base = group === "services" ? toolDir(name) : contractsDir;
      for (const entry of config.files ?? []) {
        const output = entry.how === "types" ? manifest.languages?.[language]?.types : entry;
        const target = output?.target;
        if (
          !target ||
          !target.startsWith(root + "/") ||
          !within(join(base, root), join(base, target))
        ) {
          report("vendoring", manifestFile, name + ": target must stay within " + root + "/");
          continue;
        }
        const destination = join(base, target);
        if (targets.has(destination))
          report("vendoring", manifestFile, "duplicate target " + destination);
        targets.add(destination);
        const source = join(entry.from?.startsWith("./") ? base : contractsDir, entry.from ?? "");
        if (entry.how !== "types" && !existsSync(source))
          report("vendoring", manifestFile, "source is missing: " + source);
        if (entry.how === "bundle" && existsSync(destination)) {
          const bundled = yaml(destination);
          if (
            bundled.openapi &&
            [...nodes(bundled)].some(
              ([node]) => typeof node.$ref === "string" && !node.$ref.startsWith("#"),
            )
          ) {
            report("vendoring", destination, "vendored OpenAPI references an external file");
          }
        }
      }
    }
  }

  for (const { name, kind, file } of all) {
    if (kind === "tool") {
      const entries = manifest.services?.[name]?.files as Document[] | undefined;
      if (
        !entries?.some(
          (entry) =>
            entry.how === "bundle" &&
            entry.target === "contract/openapi.yaml" &&
            join(contractsDir, entry.from) === file &&
            !entry.fromPhase,
        ) ||
        !entries.some(
          (entry) =>
            entry.how === "types" &&
            entry.from === "./contract/openapi.yaml" &&
            (entry.fromPhase ?? 0) <= 1,
        )
      ) {
        report(
          "vendoring",
          manifestFile,
          name + " requires its own OpenAPI bundle and types entry",
        );
      }
      for (const vendored of files(join(toolDir(name), "contract"))) {
        if (!targets.has(vendored))
          report("vendoring", vendored, "file is not listed in vendoring.yaml");
      }
    }
    if (
      kind === "external" &&
      !manifest.handoff?.[name]?.files?.some(
        (entry: Document) =>
          entry.how === "bundle" && join(contractsDir, entry.from) === file && !entry.fromPhase,
      )
    ) {
      report("external-callers", manifestFile, name + " has no hand-off bundle");
    }
  }
}

function checkInternalPackages(report: Report) {
  const file = "docs/adr/0019-internal-packages.md";
  const allowed = new Set(
    [...read(file).matchAll(/^\| .*`packages\/([\w-]+)`/gm)].map((match) => match[1]),
  );
  for (const name of readdirSync("packages")) {
    if (isDirectory(join("packages", name)) && !allowed.has(name)) {
      report("internal-packages", "packages/" + name, "package is not justified in ADR 0019");
    }
  }
  for (const root of ["apps", "packages", "services"]) {
    for (const path of files(root, "/package.json")) {
      for (const [name, version] of packagesOf(json(path))) {
        if (
          name.startsWith("@rex/") &&
          (!allowed.has(name.slice(5)) || name === "@rex/contracts" || !exactVersion.test(version))
        ) {
          report("internal-packages", path, name + " must be an approved exact pin");
        }
        if (root === "services" && version.startsWith("workspace:")) {
          report("internal-packages", path, "workspace link: " + name);
        }
      }
    }
  }
}

function anchors(file: string) {
  return new Set(
    [...read(file).matchAll(/^#{1,6}\s+(.+)$/gm)].map(([, heading]) =>
      heading
        .toLowerCase()
        .replace(/[^`a-z0-9_ -]/g, "")
        .replaceAll("`", "")
        .trim()
        .replaceAll(" ", "-"),
    ),
  );
}

function checkAgentInstructions(all: Spec[], report: Report) {
  const root = "AGENTS.md";
  const agents = read(root);
  const roadmap = read(roadmapFile);
  const accepted = files("docs/adr", ".md").filter((file) =>
    /^- \*\*Status:\*\* Accepted/m.test(read(file)),
  );
  const superseded = files("docs/adr", ".md")
    .filter((file) => /^- \*\*Status:\*\* Superseded/m.test(read(file)))
    .map((path) => basename(path).slice(0, 4));
  const status = (doc: string) =>
    doc.match(/^\*\*Status:\*\* ([\s\S]+?)(?=\n\n)/m)?.[1].replace(/\s+/g, " ");
  const phase = /\*\*Current phase:\*\* (\d+)/.exec(agents)?.[1];
  for (const rule of [
    "self-contained",
    "never retry",
    "No imports outside",
    "No `workspace:`",
    "Contracts are edited only",
    "Never hand-edit generated",
    "Accepted ADRs",
    "portability beats DRY",
    "Deterministic first",
    "Cache first",
  ]) {
    if (!agents.includes(rule)) report("agent-instructions", root, "missing hard rule: " + rule);
  }
  if (
    status(agents) !== status(roadmap) ||
    phase !== /\*\*Current phase:\*\* (\d+)/.exec(roadmap)?.[1] ||
    superseded.some((id) => !status(agents)?.includes(id)) ||
    accepted
      .filter((file) => /^[0-9]{4}-/.test(basename(file)))
      .some((file) => {
        const number = Number(basename(file).slice(0, 4));
        const [, first, last] = status(agents)?.match(/(\d{4}) to (\d{4})/) ?? [];
        return !(
          (number >= Number(first) && number <= Number(last)) ||
          status(agents)?.includes(basename(file).slice(0, 4))
        );
      })
  ) {
    report(
      "agent-instructions",
      root,
      "phase or ADR status disagrees with the roadmap and ADR files",
    );
  }
  for (const file of files("docs/adr", ".md").filter((file) =>
    /^- \*\*Status:\*\* Proposed\s*$/m.test(read(file)),
  )) {
    if (!status(agents)?.includes(basename(file).slice(0, 4)))
      report("agent-instructions", root, "missing Proposed ADR " + file);
  }
  for (const path of ["CLAUDE.md", ".cursor/rules/rex.mdc", ".github/copilot-instructions.md"]) {
    const pointer = read(path);
    if (
      !pointer.includes("AGENTS.md") ||
      pointer.trimEnd().split("\n").length > 12 ||
      /^(?:\d+\.|-)\s/m.test(pointer)
    ) {
      report("agent-instructions", path, "must be a thin pointer to AGENTS.md");
    }
  }
  const commands = agents.split("## Commands")[1].split("## Definition of done")[0];
  const installed = json("package.json").devDependencies;
  for (const [, name, version] of commands.matchAll(
    /\bnpx\s+(?:-y\s+)?(@?[^@\s]+)(?:@([^\s]+))?/g,
  )) {
    if (!version || installed[name] !== version)
      report("agent-instructions", root, "npx pin differs from root manifest: " + name);
  }
  const working = commands.split("### Arrives")[0];
  const planned = commands.split("### Arrives")[1]?.split("### Inside")[0] ?? "";
  for (const block of [working, planned]) {
    for (const [, path] of block.matchAll(/^\s*(scripts\/[\w.-]+)\b/gm)) {
      if (block === working ? !existsSync(path) : existsSync(path) || !roadmap.includes(path)) {
        report("agent-instructions", root, "script misplaced in command list: " + path);
      }
    }
  }

  for (const file of [
    root,
    ...all
      .filter(({ kind }) => kind === "tool")
      .map(({ name }) => join(toolDir(name), "AGENTS.md")),
  ]) {
    if (!existsSync(file)) {
      report("agent-instructions", file, "missing");
      continue;
    }
    for (const [, href] of read(file).matchAll(/\]\(([^\s)]+)\)/g)) {
      if (/^(?:https?:|mailto:)/.test(href)) continue;
      const [link, anchor] = href.split("#");
      const target = link ? join(dirname(file), decodeURIComponent(link)) : file;
      if (
        !existsSync(target) ||
        (anchor && target.endsWith(".md") && !anchors(target).has(anchor))
      ) {
        report("agent-instructions", file, "broken link " + href);
      }
    }
  }
}

export function checkRepo(all: Spec[], manifest: Document, policy: Document, report: Report) {
  checkVendoring(all, manifest, report);
  checkInternalPackages(report);
  checkAgentInstructions(all, report);
  const architecture = read(architectureFile);
  const docs = [
    architectureFile,
    conventionsFile,
    roadmapFile,
    "docs/events.md",
    ...files("docs/services", ".md"),
  ];
  const repeated = [
    policy.key?.format,
    ...(policy.key?.canonicalInput ?? []),
    ...(policy.resolution?.rules ?? []),
  ]
    .filter((line) => typeof line === "string" && line.length > 24)
    .map((line) => line.replace(/\s+/g, " ").toLowerCase());
  const externalPattern = externalNames.join("|");
  const externalUrl = new RegExp(
    "\\b(?:" +
      externalNames.map((name) => name.toUpperCase().replaceAll("-", "_")).join("|") +
      ")_URL\\b",
  );
  const allowedUrlDocs = new Set([serviceDoc("workers"), ...externalNames.map(serviceDoc)]);
  const caller = new RegExp(
    "\\b(?:gateway|orchestrator|dashboard|tools?)\\s+(?:(?:can|will|also|directly)\\s+)*(?:calls?|invokes?|requests? from) (?:the )?(" +
      externalPattern +
      ")\\b",
    "i",
  );
  const externalRows = table(architecture, /^\| Kind \| Services \| State /m);
  for (const [kind, , , , , dependencies] of externalRows)
    if (
      ["orchestrator", "gateway", "tool", "dashboard"].includes(kind) &&
      new RegExp(externalPattern).test(dependencies.split(/; never\b/)[0])
    ) {
      report(
        "external-callers",
        architectureFile,
        "external dependency in a non-worker service row",
      );
    }
  const addrs = new Map<string, string>();
  for (const [, id, label] of architecture.matchAll(/(\w+)\["([^"]+)"\]/g)) {
    if (externalNames.some((name) => label.startsWith(name + " ("))) addrs.set(id, label);
  }
  for (const [, origin, target] of architecture.matchAll(
    /^\s*(\w+)\s+(?:-->|-\.->)(?:\|"[^"]+"\|)?\s+(\w+)/gm,
  )) {
    if (addrs.has(target) && origin !== "workers")
      report("external-callers", architectureFile, origin + " calls " + addrs.get(target));
  }

  for (const name of externalNames) {
    const file = serviceDoc(name);
    if (
      !existsSync(file) ||
      !/^[-] \*\*Kind:\*\* external\b/m.test(read(file)) ||
      (!all.some((entry) => entry.name === name) &&
        !/^## (?:Not known yet|Unknown)/m.test(read(file)))
    ) {
      report(
        "external-callers",
        file,
        "external service needs a doc and a list of unknown interface details when no contract exists",
      );
    }
  }

  for (const file of docs) {
    const doc = read(file);
    const text = doc.replace(/\s+/g, " ").toLowerCase();
    if (
      repeated.some((line) => text.includes(line)) ||
      /\bcustomer\s*(?:>|→|->|then)\s*environment\s*(?:>|→|->|then)\s*default\b/i.test(doc)
    ) {
      report("cache-policy", file, "cache key rules and precedence live in policy.yaml");
    }
    if (
      /\b(?:retry delays?|retry schedule|retry delay pool)\s*(?:are|is|:|=)\s*`?\[?\d+\s*(?:ms|seconds?|s|minutes?|m)\b/i.test(
        doc,
      )
    ) {
      report("retry", file, "concrete retry delays belong in topology.yaml");
    }
    const urlContext =
      file === architectureFile
        ? doc
            .split("\n")
            .filter((line) => !/^\| Workers?\s*(?:→|->)/i.test(line))
            .join("\n")
        : file === conventionsFile
          ? doc.replace(
              /`CONTENT_EXTRACTOR_URL`,[\s\S]*?\(base URLs of the external services\)[\s\S]*?only[^.]*\./,
              "",
            )
          : doc;
    if ((!allowedUrlDocs.has(file) && externalUrl.test(urlContext)) || caller.test(doc)) {
      report(
        "external-callers",
        file,
        "only workers call external services or configure their URLs",
      );
    }
    if (file !== conventionsFile && /^\| Package \| Purpose \| Tools \|/m.test(doc)) {
      report("approved-dependencies", file, "approved package tables belong in conventions");
    }
    if (/\b--fetch\b/.test(doc) && !/\bno (?:tool )?--fetch\b/.test(doc)) {
      report("external-callers", file, "tool templates must not have a fetch switch");
    }
  }
  const serviceSources = ["services", "apps", "packages"]
    .flatMap((root) => files(root))
    .filter(
      (path) =>
        !within(toolDir("workers"), path) &&
        !within(contractsDir, path) &&
        !path.includes("/contract/") &&
        /(?:\.(?:[jt]sx?|py|go|md|toml|json|ya?ml)|\/\.env[^/]*|\/Dockerfile)$/.test(path),
    );
  const toolSpecs = all.filter(({ kind }) => kind === "tool").map(({ file }) => file);
  for (const path of [...serviceSources, ...toolSpecs]) {
    if (!lstatSync(path).isSymbolicLink() && externalUrl.test(read(path))) {
      report("external-callers", path, "only workers configure external service URLs");
    }
  }
}
