import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { bus, matchesTopic } from "./bus.js";
import { checkRepo } from "./check-repo.js";
import { checkSpecs, duration, type Report } from "./check-specs.js";
import {
  commonFile,
  currentPhase,
  eventsFile,
  main,
  manifestFile,
  policyFile,
  specs,
  topologyFile,
  yaml,
  type Document,
} from "./contracts.js";

function checkBus(report: Report) {
  const { events, topology, channels } = bus();
  const names = new Set(channels.map(({ message }) => message.name));
  const routingKeys = new Set(channels.map(({ channel }) => channel.address));
  const versions = new Set<string>();
  for (const { channel, message, envelope, queues, version } of channels) {
    const name = message.name;
    const producers = channel["x-rex-producers"];
    if (
      !queues.length ||
      !Array.isArray(producers) ||
      !producers.length ||
      producers.some((producer: string) => !["orchestrator", "workers"].includes(producer))
    ) {
      report("bus", eventsFile, name + " lacks a queue binding or has an invalid producer");
    }
    if (
      (name.endsWith(".requested") && JSON.stringify(producers) !== '["orchestrator"]') ||
      (/\.(?:completed|failed)$/.test(name) && JSON.stringify(producers) !== '["workers"]') ||
      !(
        envelope?.type?.const === name ||
        (name.endsWith(".failed") &&
          envelope?.type?.pattern &&
          new RegExp(envelope.type.pattern).test(name))
      ) ||
      !Number.isInteger(version) ||
      version < 1 ||
      (channel.address !== name && !channel.address.startsWith(name + ".{"))
    ) {
      report(
        "bus",
        eventsFile,
        name + " disagrees with its producer, version, type or routing key",
      );
    }
    const identity = name + "@" + version;
    if (versions.has(identity)) report("bus", eventsFile, "duplicate message " + identity);
    versions.add(identity);
    if (name.endsWith(".requested")) {
      for (const result of ["completed", "failed"]) {
        if (!names.has(name.replace(/requested$/, result)))
          report("bus", eventsFile, name + " lacks a " + result + " sibling");
      }
    }
  }
  const delays = topology.retry?.delayPool ?? [];
  const retry = [
    topology.retry?.defaults,
    ...Object.values(topology.retry?.perQueue ?? {}),
  ] as Document[];
  for (const queue of topology.queues as Document[]) {
    if (
      !["orchestrator", "workers"].includes(queue.consumer) ||
      !(Number.isInteger(queue.prefetch) && queue.prefetch > 0)
    ) {
      report("bus", topologyFile, queue.name + " has an invalid consumer or prefetch");
    }
    if (queue.retry) retry.push(queue.retry);
    for (const binding of queue.bindings) {
      if (
        !(binding.exchange in topology.exchanges) ||
        (binding.exchange === "events" &&
          ![...routingKeys].some((key) => matchesTopic(binding.routingKey, key)))
      ) {
        report(
          "bus",
          topologyFile,
          queue.name + " binding matches no message: " + binding.routingKey,
        );
      }
    }
  }
  if (
    !delays.length ||
    delays.some((delay: string) => !/^[1-9]\d*(?:ms|s|m|h)$/.test(delay) && !(duration(delay) > 0))
  ) {
    report("retry", topologyFile, "delayPool must contain positive durations");
  }
  for (const config of retry) {
    for (const delay of config?.delays ?? [])
      if (!delays.includes(delay))
        report("retry", topologyFile, delay + " is outside retry.delayPool");
  }
  for (const channel of Object.values<Document>(events.channels)) {
    if (!channel.bindings?.$ref)
      report("bus", eventsFile, channel.address + " must reference its exchange");
  }
}

main(() => {
  const { values } = parseArgs({
    options: {
      phase: { type: "string", default: String(currentPhase) },
      "source-only": { type: "boolean" },
    },
  });
  const problems: string[] = [];
  const report: Report = (rule, file, message) =>
    problems.push("[" + rule + "] " + file + ": " + message);
  const all = specs();
  const policy = yaml(policyFile);
  const manifest = yaml(manifestFile);
  checkSpecs(all, yaml(commonFile), policy, yaml(eventsFile), report);
  checkBus(report);
  checkRepo(all, manifest, policy, report);

  if (!values["source-only"]) {
    for (const [script, args] of [
      ["scripts/vendor-contracts", ["--check", "--phase", values.phase!]],
      ["scripts/gen-docs", ["--check"]],
    ] as const) {
      try {
        execFileSync(script, [...args], { stdio: "inherit" });
      } catch {
        report("generated", script, "generation check failed");
      }
    }
  }
  if (problems.length) throw new Error(problems.join("\n"));
  console.log("Cross-file contract checks passed");
});
