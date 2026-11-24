import { performance } from "node:perf_hooks";
import type { components } from "../../contract/types.js";
import type { Handlers } from "../app.js";
import { validators, type ToolSpec } from "../contract.js";
import { renderAnswer } from "../domain/citations.js";
import { ToolProblem } from "../errors.js";
import { createLlm } from "../llm/adapter.js";
import { deployment } from "../llm/catalog.js";
import type { EngineConfig } from "../tool-env.js";

type Query = Required<components["schemas"]["EngineQuery"]>;

export function createHandlers(spec: ToolSpec, config: EngineConfig, call = createLlm()): Handlers {
  const engines = deployment(config.ENGINE_QUERY_GROK_ENABLED);
  const urlSchema = spec.components?.schemas?.Url;
  if (!urlSchema) throw new Error("Missing bundled Url schema");
  const validUrl = validators(spec, false)(urlSchema);
  return {
    listEngines: async () => ({ data: engines.map(({ engine }) => engine) }),
    queryEngine: async (request) => {
      const { engine, prompt, locale, country } = request.body as Query;
      const entry = engines.find(({ engine: configured }) => configured.id === engine);
      if (!entry)
        throw new ToolProblem(422, "unsupported_engine", "/engine: Engine is not configured");

      const start = performance.now();
      const { parts, usage } = await call(entry, prompt, locale, country, (message) =>
        request.log.warn({ provider: entry.engine.provider, model: entry.engine.model }, message),
      );
      return {
        answer: {
          engine: entry.engine.id,
          model: entry.engine.model,
          ...renderAnswer(parts, validUrl),
          latencyMs: Math.round(performance.now() - start),
        },
        usage: [usage],
      };
    },
  };
}
