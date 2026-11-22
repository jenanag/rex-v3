import { eventsFile, nodes, resolver, topologyFile, yaml, type Document } from "./contracts.js";

export function matchesTopic(pattern: string, key: string): boolean {
  const words = key.split(".");
  function matches(parts: string[], offset: number): boolean {
    const [first, ...rest] = parts;
    if (!first) return offset === words.length;
    if (first === "#") {
      for (let next = offset; next <= words.length; next++) {
        if (matches(rest, next)) return true;
      }
      return false;
    }
    return (
      offset < words.length &&
      (first === "*" || first === words[offset]) &&
      matches(rest, offset + 1)
    );
  }
  return matches(pattern.split("."), 0);
}

export function bus() {
  const events = yaml(eventsFile);
  const topology = yaml(topologyFile);
  const lookup = resolver();
  const channels = Object.values<Document>(events.channels).flatMap((channel) =>
    Object.values<Document>(channel.messages).map((ref) => {
      const message = lookup(eventsFile, ref.$ref).value;
      const payload = message.payload.$ref
        ? lookup(eventsFile, message.payload.$ref).value
        : message.payload;
      const envelope = [...nodes(payload)].find(([node]) => node.properties?.data)?.[0].properties;
      const queues = (topology.queues as Document[]).filter((queue) =>
        queue.bindings.some(
          (binding: Document) =>
            binding.exchange === "events" && matchesTopic(binding.routingKey, channel.address),
        ),
      );
      return { channel, message, envelope, queues };
    }),
  );
  const versions = new Map(
    channels
      .filter(({ envelope }) => envelope?.version?.const)
      .map(({ message, envelope }) => [message.name, envelope!.version.const]),
  );
  return {
    events,
    topology,
    channels: channels.map((entry) => ({
      ...entry,
      version:
        entry.envelope?.version?.const ??
        versions.get(entry.message.name.replace(/\.failed$/, ".requested")),
    })),
  };
}
