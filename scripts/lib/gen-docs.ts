import { existsSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { bus } from "./bus.js";
import {
  applicablePackages,
  commonFile,
  files,
  main,
  manifestFile,
  nodes,
  operations,
  policyFile,
  pointer,
  read,
  serviceDoc,
  specs,
  tick,
  toolDir,
  yaml,
  type Document,
} from "./contracts.js";

const conventions = read("docs/conventions.md");
const roadmap = read("docs/roadmap.md");
const manifest = yaml(manifestFile);
const policy = yaml(policyFile);
const allSpecs = specs();
const { events, channels, topology } = bus();
const common = yaml(commonFile);
const languageDecisions = read("docs/adr/0024-per-tool-language.md");
const phaseTwo = roadmap.split(/^## Phase 2:/m)[1].split(/^## /m)[0];
const steps = [...phaseTwo.matchAll(/^(\d+)\. `([\w-]+)`: ([^\n]*(?:\n[ \t]+\S[^\n]*)*)/gm)];

const markdownLink = (name: string, uri: string) => "[" + name + "](" + uri + ")";
const table = (headings: string[], rows: unknown[][]) =>
  [headings, headings.map(() => "---"), ...rows]
    .map(
      (row) =>
        "| " + row.map((value) => String(value ?? "").replaceAll("|", "\\|")).join(" | ") + " |",
    )
    .join("\n");
const list = (items: string[]) => items.map((item) => "- " + item).join("\n");
const compact = (value: string) => value.trim().replace(/\s+/g, " ");
const probes = "- `GET /healthz`, `GET /readyz`: shared probes";
const eventLink = (name: string) => markdownLink(tick(name), "../events.md#catalog");
const gatewayPath = (path: string) => "/v1/tools" + path.slice("/v1".length);

function wrap(value: string, indent = "") {
  const lines: string[] = [];
  let line = "";
  for (const word of compact(value).split(" ")) {
    if (line && line.length + 1 + word.length > 88) {
      lines.push(line);
      line = word;
    } else {
      line += line ? " " + word : word;
    }
  }
  return [...lines, line].join("\n" + indent);
}

function schemaName(field: Document): string {
  return field.$ref?.split("/").at(-1) ?? field.type ?? "schema";
}

function catalog() {
  return table(
    ["Message", "v", "Routing key", "Producer", "Consumer (queue)", "`data`", "Summary"],
    channels.map(({ channel, message, envelope, queues, version }) => {
      const data = envelope!.data;
      const payload = data.properties
        ? "{ " +
          Object.entries<Document>(data.properties)
            .map(([name, field]) => {
              const type = schemaName(field);
              const source = field.$ref?.split("#")[0];
              const label = source?.startsWith("../openapi/services/")
                ? markdownLink(type, "../packages/contracts/" + source.slice(3))
                : type;
              return tick(name) + ": " + label;
            })
            .join(", ") +
          " }"
        : tick(schemaName(data));
      const consumers = queues.map(
        ({ consumer, name }) => consumer + " (" + tick(name.replace("{engine}", "<engine>")) + ")",
      );
      return [
        tick(message.name),
        version,
        tick(channel.address),
        channel["x-rex-producers"].join(", "),
        consumers.join(", "),
        payload,
        compact(message.summary),
      ];
    }),
  );
}

function messages(name: string) {
  const outgoing = channels.filter(({ channel }) => channel["x-rex-producers"].includes(name));
  const incoming = (topology.queues as Document[]).filter(({ consumer }) => consumer === name);
  return [
    "- **Publishes:** " + outgoing.map(({ message }) => eventLink(message.name)).join(", "),
    "- **Consumes:**",
    ...incoming.map(
      (queue) =>
        "  - " +
        tick(queue.name) +
        " (prefetch " +
        queue.prefetch +
        "): " +
        channels
          .filter(({ queues }) => queues.includes(queue))
          .map(({ message }) => eventLink(message.name))
          .join(", "),
    ),
  ].join("\n");
}

function endpoints(name: string, spec: Document) {
  if (name === "gateway") {
    return [
      "Public tool routes (anonymous, rate limited per IP):",
      ...allSpecs.flatMap(({ spec: tool, name: owner }) =>
        operations(tool)
          .filter(({ op }) => op["x-rex-public"])
          .map(
            ({ method, path, op }) =>
              "- " +
              tick(method.toUpperCase() + " " + gatewayPath(path)) +
              " to " +
              owner +
              " " +
              tick(op.operationId),
          ),
      ),
      probes,
    ].join("\n");
  }
  const groups = new Map<string, string[]>();
  for (const { method, path, op } of operations(spec)) {
    const tag = name === "orchestrator" ? (op.tags?.[0] ?? "Other") : "";
    const label =
      tick(method.toUpperCase() + " " + path) +
      ": " +
      tick(op.operationId) +
      (op["x-internal"] ? " (internal)" : "") +
      (op["x-rex-public"] ? " (public via gateway at " + tick(gatewayPath(path)) + ")" : "");
    const group = groups.get(tag) ?? [];
    group.push(label);
    groups.set(tag, group);
  }
  const lines = [...groups].flatMap(([tag, group]) =>
    tag
      ? ["- **" + tag + "**", ...group.map((line) => "  - " + line)]
      : group.map((line) => "- " + line),
  );
  return [...lines, probes].join("\n");
}

function cache(name: string, doc: string) {
  const external = policy.external[name];
  const config = external ?? policy.tools[name];
  const source = "[policy.yaml](../../packages/contracts/cache/policy.yaml)";
  const intro = external
    ? "Callers: " + config.callers.join(", ") + " only. Cache policy: " + source + " (`external`)."
    : "Caller cache policy: " + source + " ([ADR 0016](../adr/0016-cache-first.md)).";
  if (!config) {
    const phase = doc.match(/^- \*\*Phase:\*\* (\d+)/m)?.[1];
    return intro + "\n\nPolicy entries arrive with the Phase " + phase + " contract.";
  }
  const rows = Object.entries<Document>(config.operations).map(([operation, entry]) => [
    tick(operation),
    entry.cacheable === false ? "Never cached" : tick(entry.ttl ?? entry.window),
    entry.scope,
    [
      entry.window && "window",
      entry.skipWhen &&
        "skip when " + tick(entry.skipWhen.pointer) + " = " + tick(entry.skipWhen.equals),
      policy.byReference?.includes(name + "." + operation) && "read back by reference",
      entry.extraKeyInputs && "extra key inputs " + entry.extraKeyInputs.map(tick).join(", "),
      entry.rawUrlKeyInputs &&
        "raw URL key inputs " +
          Object.entries(entry.rawUrlKeyInputs)
            .map(([alias, pointer]) => tick(alias) + " from " + tick(pointer))
            .join(", "),
      entry.preserveArrayOrder &&
        "preserve array order at " + entry.preserveArrayOrder.map(tick).join(", "),
      entry.normalize && "normalization in " + source,
    ]
      .filter(Boolean)
      .join(", "),
  ]);
  return [
    intro,
    "keyVersion " +
      tick(config.keyVersion) +
      ". The values below are defaults; scope and freshness can be overridden per environment and per customer (policy.yaml `resolution`).",
    table(["Operation", "Kept for", "Scope", "Notes"], rows),
  ].join("\n\n");
}

function shared(spec: Document) {
  return [
    ...new Set(
      [...nodes(spec)].flatMap(([node]) =>
        typeof node.$ref === "string" && node.$ref.startsWith("../common.yaml#/components/")
          ? [node.$ref]
          : [],
      ),
    ),
  ].sort();
}

function sharedLines(name: string, spec: Document, linked: boolean) {
  return list(
    shared(spec).map((ref) => {
      const [, kind, key] = ref.split("/").slice(-3);
      const label = linked
        ? markdownLink(tick(key), "../../packages/contracts/openapi/common.yaml")
        : tick(key);
      const uses = allSpecs
        .filter(
          ({ name: other, spec: consumer }) => other !== name && shared(consumer).includes(ref),
        )
        .map(({ name: other }) => other);
      if (shared(events).includes(ref)) uses.push("bus messages");
      return (
        label + " (" + kind + ")" + (uses.length ? "; also used by " + uses.join(", ") : "") + "."
      );
    }),
  );
}

function limitLines(spec: Document) {
  return list(
    operations(spec).map(({ op }) => {
      const limit = op["x-rex-limits"];
      return (
        tick(op.operationId) +
        " (" +
        (op["x-rex-public"] ? "public" : "workers only") +
        "): " +
        Object.entries(limit)
          .filter(([key]) => key !== "notes")
          .map(([key, value]) => key + " " + tick(value))
          .join(", ") +
        (limit.notes ? ". " + limit.notes : "")
      );
    }),
  );
}

const hasLlm = (spec: Document) =>
  operations(spec).some(({ op }) => op["x-rex-limits"]?.llm !== "none");
function packageLines(name: string, spec: Document) {
  return list(
    applicablePackages(
      conventions,
      manifest.services[name].language,
      name,
      hasLlm(spec) ||
        (manifest.services[name].example === true && manifest.services[name].llm === true),
    ).map(
      ({ name: pkg, purpose, scopes }) =>
        tick(pkg) + ": " + purpose + (scopes.includes("--llm") ? " (`--llm`)" : ""),
    ),
  );
}

function renderServiceBlock(block: string, name: string, doc: string) {
  const spec = allSpecs.find((entry) => entry.name === name)?.spec;
  switch (block) {
    case "endpoints":
      return endpoints(name, spec!);
    case "cache":
      return cache(name, doc);
    case "limits":
      return spec!["x-rex-service"].kind === "tool"
        ? "See [the tool's operation limits](../../services/" + name + "/AGENTS.md#limits)."
        : limitLines(spec!);
    case "shared":
      return sharedLines(name, spec!, true);
    case "deps":
      return packageLines(name, spec!);
    case "messages":
      return messages(name);
    default:
      throw new Error(serviceDoc(name) + ": unknown generated block " + block);
  }
}

const stripLinks = (value: string) => value.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
const commonRef = /^(?:[^/#]+\/)*common\.yaml(#\/components\/[^/]+\/[^/]+)/;
const localComponent = /^(#\/components\/[^/]+\/[^/]+)/;
const componentLabels: Record<string, string> = {
  schemas: "schema",
  responses: "response",
  parameters: "parameter",
  headers: "header",
};

function refs(value: unknown) {
  return [...nodes(value)].flatMap(([node]) => (typeof node.$ref === "string" ? [node.$ref] : []));
}

function commonUsers(spec: Document) {
  const used = new Set<string>();
  function add(fragment: string) {
    if (used.has(fragment)) return;
    used.add(fragment);
    for (const ref of refs(pointer(common, fragment))) {
      const nested = ref.match(localComponent)?.[1];
      if (nested) add(nested);
    }
  }
  for (const ref of refs(spec)) {
    const fragment = ref.match(commonRef)?.[1];
    if (fragment) add(fragment);
  }
  return used;
}

const serviceUsage = new Map([
  ...allSpecs.map(({ name, spec }) => [name, commonUsers(spec)] as const),
  ["bus messages", commonUsers(events)],
]);

function agentShared(name: string, spec: Document) {
  const usage = new Map<string, Set<string>>();
  for (const { op, item } of operations(spec)) {
    for (const [side, body] of [
      ["request", [op.requestBody, op.parameters, item.parameters]],
      ["response", op.responses],
    ] as const) {
      const pending = refs(body);
      const seen = new Set<string>();
      while (pending.length) {
        const ref = pending.pop()!;
        if (seen.has(ref)) continue;
        seen.add(ref);
        const fragment = ref.match(commonRef)?.[1];
        if (fragment && componentLabels[fragment.split("/")[2]]) {
          const sides = usage.get(fragment) ?? new Set<string>();
          sides.add(side);
          usage.set(fragment, sides);
        } else if (localComponent.test(ref)) {
          pending.push(...refs(pointer(spec, ref.match(localComponent)![1])));
        }
      }
    }
  }

  const parts = [...usage]
    .map(([fragment, sides]) => {
      const [, , kind, key] = fragment.split("/");
      return { fragment, kind, key, sides };
    })
    .sort(
      (a, b) =>
        Number(a.kind !== "schemas") - Number(b.kind !== "schemas") ||
        (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );

  return parts
    .map(({ fragment, kind, key, sides }) => {
      const consumers = [...serviceUsage]
        .filter(([other, used]) => other !== name && used.has(fragment))
        .map(([other]) => other);
      const side = ["request", "response"].filter((value) => sides.has(value)).join(" and ");
      const label =
        kind === "responses" && side === "response"
          ? "error response"
          : componentLabels[kind] + ", " + side;
      const others = consumers.length
        ? "also used by " + consumers.join(", ")
        : "no other service uses it yet";
      return wrap("- " + tick(key) + " (" + label + "); " + others + ".", "  ");
    })
    .join("\n");
}

function agentLimits(spec: Document) {
  return operations(spec)
    .map(({ op }) => {
      const limit = op["x-rex-limits"];
      const llm: Record<string, string> = {
        none: "no LLM",
        optional: "LLM only when the request asks for it",
        required: "one LLM call",
      };
      const fetches: Record<string, string> = {
        none: "no outbound fetch",
        one: "at most one outbound fetch",
        several: "several outbound fetches",
        crawl: "a crawl",
      };
      const description = [
        op["x-rex-public"] ? "public" : "internal (workers only)",
        limit.maxDuration ? "max duration " + limit.maxDuration : "no max duration stated yet",
        limit.p99 && "p99 under " + limit.p99,
        llm[limit.llm],
        limit.llmCallTimeout && "each LLM call up to " + limit.llmCallTimeout,
        fetches[limit.outboundFetch],
      ]
        .filter(Boolean)
        .join("; ");
      return wrap(
        "- " +
          tick(op.operationId) +
          ": " +
          description +
          (limit.notes ? " (" + limit.notes + ")" : "") +
          ".",
        "  ",
      );
    })
    .join("\n");
}

function languageLine(name: string, language: string, languageName: string) {
  const decision = [
    ...languageDecisions.matchAll(
      /^\| `([\w-]+)` \| (\d+) \| (\w+) \((Proposed|Decided by Jay)\) \| (.+?) \|$/gm,
    ),
  ].find(([, tool]) => tool === name);
  if (!decision) throw new Error(name + ": missing language rationale in ADR 0024");
  const [, , phase, proposed, status, rationale] = decision;
  const current = "(" + tick("language: " + language) + " in vendoring.yaml)";
  // Keep ADR 0024's guidance unless an accepted tool ADR resolves a different proposal.
  if (languageName !== proposed) {
    const accepted = files("docs/adr", "-" + name + "-language.md")
      .reverse()
      .find((path) => {
        const header = read(path).split(/^## /m)[0];
        return (
          /^- \*\*Status:\*\* Accepted\b/m.test(header) &&
          header.split("\n").includes("- **Tool:** " + tick(name)) &&
          header.split("\n").includes("- **Language:** " + tick(language))
        );
      });
    if (accepted) {
      const number = basename(accepted).split("-")[0];
      return wrap(languageName + " " + current + ", accepted by Jay in ADR " + number + ".");
    }
  }
  const when =
    phase === "2"
      ? "at the start of its Phase 2 step"
      : "at the start of its phase (Phase " + phase + ")";
  if (languageName === proposed) {
    const attribution =
      status === "Decided by Jay" ? "as Jay decided in ADR 0024" : "as ADR 0024 proposes";
    return wrap(
      languageName +
        " " +
        current +
        ", " +
        attribution +
        ": " +
        rationale +
        ". Its own language ADR, accepted by Jay, confirms it " +
        when +
        ".",
    );
  }
  return wrap(
    languageName +
      " for now " +
      current +
      ". ADR 0024 proposes " +
      proposed +
      ": " +
      rationale +
      ". Its own language ADR, accepted by Jay, decides " +
      when +
      ".",
  );
}

function agent(name: string, spec: Document) {
  const config = manifest.services[name];
  const example = config.example === true;
  const language = config.language as "ts" | "python" | "go";
  const doc = read(serviceDoc(name));
  const languageName = manifest.languages[language].name;
  const step = steps.find((match) => match[2] === name);
  if (!step && !example) throw new Error(name + ": missing Phase 2 roadmap step");
  const purpose = compact(stripLinks(doc.split("\n## Purpose\n")[1].trim().split("\n\n")[0]));
  const llm = hasLlm(spec) || (example && config.llm === true);
  const bundle = config.files.find((entry: Document) => entry.target === "contract/openapi.yaml");
  const values: Record<string, string> = {
    name,
    language_name: languageName,
    purpose: wrap(
      purpose
        .split(/(?<=\.) /)
        .filter((sentence) => !sentence.startsWith("Replaces the v1"))
        .join(" "),
    ),
    language_line: example
      ? languageName + " (Phase 1 echo example)."
      : languageLine(name, language, languageName),
    from: bundle.from,
    extra_files: config.files
      .filter((entry: Document) => entry.how === "copy")
      .map(
        (entry: Document) =>
          "- Data: " +
          markdownLink(entry.target, entry.target) +
          ", a generated copy of\n  " +
          tick("packages/contracts/" + entry.from) +
          ".\n",
      )
      .join(""),
    operations: operations(spec)
      .map(({ method, path, op }) =>
        wrap(
          "- " +
            tick(op.operationId) +
            " (" +
            tick(method.toUpperCase() + " " + path) +
            "): " +
            compact(op.summary).replace(/\.+$/, "") +
            ".",
          "  ",
        ),
      )
      .join("\n"),
    shared: agentShared(name, spec),
    limits: agentLimits(spec),
    switches: llm ? tick("--llm") : "none",
    packages: applicablePackages(conventions, language, name, llm)
      .map(({ name: pkg, purpose, scopes }) =>
        wrap(
          "- " +
            tick(pkg) +
            ": " +
            purpose +
            (scopes.includes("all") ? "" : " (" + scopes.join(", ") + ")"),
          "  ",
        ),
      )
      .join("\n"),
    step: step?.[1] ?? "1",
    steps: String(steps.length),
    scope: step ? compact(step[3]) : "Standalone echo example.",
    status: existsSync(
      join(
        toolDir(name),
        { ts: "package.json", python: "pyproject.toml", go: "go.mod" }[language]!,
      ),
    )
      ? "Scaffolded: these commands work in this folder."
      : wrap(
          "Not scaffolded yet: today this folder holds only this file and `contract/`. " +
            "`scripts/new-tool` (built in Phase 1) scaffolds the rest at the start of this tool's Phase 2 step, with `--lang` as its language ADR decides" +
            (llm ? " and `--llm`" : "") +
            ". Then these commands work (for the language above):",
        ),
  };
  return read("services/_template/AGENTS.md.tmpl")
    .replace(/{{#lang (\w+)}}\n([\s\S]*?){{\/lang}}\n/g, (_, lang, body) =>
      lang === language ? body : "",
    )
    .replace(/{{(\w+)}}/g, (_, key) => {
      if (!Object.hasOwn(values, key))
        throw new Error("Unknown tool AGENTS template field: " + key);
      return values[key];
    })
    .replace(/^Phase 2, step [^\n]+/m, (line) =>
      example ? "Phase 1 standalone echo example." : wrap(line),
    );
}

function blocks(doc: string, expected: string[], render: (name: string) => string) {
  const seen = new Set<string>();
  const output = doc.replace(
    /(<!-- GENERATED:([\w-]+) START[^\n]*-->\n)[\s\S]*?(<!-- GENERATED:\2 END -->)/g,
    (_, start, name, end) => {
      if (seen.has(name)) throw new Error("Duplicate generated block " + name);
      seen.add(name);
      return start + render(name) + "\n" + end;
    },
  );
  const missing = expected.filter((name) => !seen.has(name));
  if (missing.length) throw new Error("Missing generated block markers: " + missing.join(", "));
  return output;
}

main(() => {
  const { values } = parseArgs({
    options: { check: { type: "boolean" }, service: { type: "string" } },
  });
  const targets = new Map<string, string>();
  targets.set(
    "docs/events.md",
    blocks(read("docs/events.md"), ["catalog"], () => catalog()),
  );
  for (const file of files("docs/services", ".md")) {
    const doc = read(file);
    const name = basename(file, ".md");
    if (values.service && name !== values.service) continue;
    const kind = allSpecs.find((entry) => entry.name === name)?.kind;
    const required =
      kind === "tool"
        ? ["endpoints", "cache", "limits", "shared", "deps"]
        : kind === "external"
          ? ["endpoints", "cache", "limits", "shared"]
          : name === "orchestrator"
            ? ["endpoints", "messages"]
            : name === "workers"
              ? ["messages"]
              : name === "gateway"
                ? ["endpoints"]
                : /^- \*\*Kind:\*\* tool\b/m.test(doc)
                  ? ["cache"]
                  : [];
    if (required.length || doc.includes("<!-- GENERATED:")) {
      try {
        targets.set(
          file,
          blocks(doc, required, (block) => renderServiceBlock(block, name, doc)),
        );
      } catch (error) {
        throw new Error(file + ": " + (error as Error).message);
      }
    }
  }
  for (const { name, spec, kind } of allSpecs) {
    if (kind === "tool" && (!values.service || values.service === name))
      targets.set(join(toolDir(name), "AGENTS.md"), agent(name, spec));
  }
  const drift = [];
  for (const [file, result] of targets) {
    if (existsSync(file) && read(file) === result) continue;
    if (values.check) drift.push(file);
    else writeFileSync(file, result);
  }
  if (drift.length) throw new Error(drift.join("\n") + "\nRun scripts/gen-docs to regenerate.");
  console.log(
    values.check
      ? "Generated docs in sync (" + targets.size + ")"
      : "Generated " + targets.size + " docs",
  );
});
