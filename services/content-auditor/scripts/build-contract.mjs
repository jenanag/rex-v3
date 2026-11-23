import { readFileSync, writeFileSync } from "node:fs";
import { parse } from "yaml";

// Keep YAML parsing in the build. The runtime consumes the exact same contract data.
const spec = parse(readFileSync(new URL("../contract/openapi.yaml", import.meta.url), "utf8"));
writeFileSync(new URL("../dist/contract.json", import.meta.url), JSON.stringify(spec));
const { crawlers } = parse(
  readFileSync(new URL("../contract/ai-crawlers.yaml", import.meta.url), "utf8"),
);
writeFileSync(new URL("../dist/ai-crawlers.json", import.meta.url), JSON.stringify(crawlers));
