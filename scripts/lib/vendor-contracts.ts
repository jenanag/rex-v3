import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  contractsDir,
  currentPhase,
  main,
  manifestFile,
  run,
  toolDir,
  within,
  yaml,
  type Document,
} from "./contracts.js";

type Entry = { destination: string; source: string; label: string; generator: string };

function plan(manifest: Document, phase: number, selected?: string): Entry[] {
  if (
    selected &&
    !manifest.services[selected] &&
    !manifest.handoff[selected] &&
    !manifest.templates?.[selected]
  ) {
    throw new Error("Unknown service: " + selected);
  }

  const entries: Entry[] = [];
  for (const [group, configs] of Object.entries<Document>({
    services: manifest.services,
    handoff: manifest.handoff,
    templates: manifest.templates ?? {},
  })) {
    for (const [name, config] of Object.entries<Document>(configs)) {
      if (selected && name !== selected) continue;
      if (
        !(
          group === "templates" ? /^_template(?:-[a-z]+)?$/ : /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
        ).test(name)
      ) {
        throw new Error("Invalid vendoring service: " + name);
      }
      const service = group !== "handoff";
      const base = service ? toolDir(name) : contractsDir;
      for (const item of config.files) {
        const fromPhase = item.fromPhase ?? 0;
        if (!Number.isSafeInteger(fromPhase) || fromPhase < 0)
          throw new Error(name + ": invalid fromPhase");
        if (fromPhase > phase) continue;
        const local = item.from.startsWith("./");
        const source = join(local ? base : contractsDir, item.from);
        if (!within(local ? base : contractsDir, source))
          throw new Error("Invalid source: " + source);
        const type = item.how === "types";
        const output = type ? manifest.languages[config.language]?.types : item;
        if (type && !output) throw new Error(name + ": unknown tool language " + config.language);
        if (type && output.how !== "openapi-typescript") {
          throw new Error(
            name + ": generator not set up yet: run the " + config.language + " bring-up",
          );
        }
        const destination = join(base, output.target);
        if (!within(join(base, service ? "contract" : "handoff"), destination)) {
          throw new Error("Invalid vendoring target: " + destination);
        }
        if (entries.some((entry) => entry.destination === destination)) {
          throw new Error("Duplicate vendoring target: " + destination);
        }
        entries.push({
          destination,
          source,
          generator: output.how,
          label: local ? source : join(contractsDir, item.from),
        });
      }
    }
  }
  return entries;
}

function vendoredHeader(manifest: Document, entry: Entry) {
  const prefix = entry.generator === "openapi-typescript" ? "//" : "#";
  // The Phase 0 header is retained verbatim for existing bundles and copies.
  return manifest.header
    .trimEnd()
    .replace("packages/contracts/{from}", entry.label)
    .split("\n")
    .map((line: string) => prefix + " " + line + "\n")
    .join("");
}

main(() => {
  const { values } = parseArgs({
    options: {
      service: { type: "string" },
      phase: { type: "string", default: String(currentPhase) },
      check: { type: "boolean" },
    },
  });
  if (!/^\d+$/.test(values.phase!) || !Number.isSafeInteger(Number(values.phase))) {
    throw new Error("--phase requires a non-negative integer");
  }
  const manifest = yaml(manifestFile);
  const entries = plan(manifest, Number(values.phase), values.service);
  const temporary = mkdtempSync(join(tmpdir(), "rex-vendor-"));
  const ready = new Map<string, { file: string; source: string }>();
  const generatedBodies = new Map<string, Buffer>();
  try {
    for (const entry of entries) {
      const { destination, source, generator } = entry;
      const input = ready.get(source)?.file ?? resolve(source);
      const staged = join(temporary, destination);
      const key = generator + ":" + source;
      let body = generatedBodies.get(key);
      if (!body) {
        switch (generator) {
          case "bundle":
            body = run("redocly", ["bundle", input]);
            break;
          case "copy":
            body = readFileSync(input);
            break;
          case "openapi-typescript": {
            const types = staged + ".ts";
            mkdirSync(dirname(types), { recursive: true });
            run("openapi-typescript", [input, "-o", types], temporary);
            body = readFileSync(types);
            break;
          }
          default:
            throw new Error("Unknown vendoring generator: " + generator);
        }
        generatedBodies.set(key, body);
      }
      mkdirSync(dirname(staged), { recursive: true });
      writeFileSync(staged, Buffer.concat([Buffer.from(vendoredHeader(manifest, entry)), body]));
      ready.set(destination, { file: staged, source });
    }

    const drift = [];
    for (const [destination, { file, source }] of ready) {
      const generated = readFileSync(file);
      const exists = existsSync(destination);
      if (exists && generated.equals(readFileSync(destination))) continue;
      if (values.check)
        drift.push(destination + (exists ? ": drifted from " + source : ": missing"));
      else {
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, generated);
      }
    }
    if (drift.length)
      throw new Error(drift.join("\n") + "\nRun scripts/vendor-contracts to regenerate.");
    console.log(
      values.check
        ? "Vendored files in sync (" + ready.size + ")"
        : "Vendored " + ready.size + " files",
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
