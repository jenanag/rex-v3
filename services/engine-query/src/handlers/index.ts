import { performance } from "node:perf_hooks";
import type { components } from "../../contract/types.js";
import type { Handlers } from "../app.js";
import { validators, type ToolSpec } from "../contract.js";
import { renderAnswer } from "../domain/citations.js";
import { ToolProblem } from "../errors.js";
import { createLlm } from "../llm/adapter.js";
import { deployment } from "../llm/catalog.js";

type Query = Required<Omit<components["schemas"]["EngineQuery"], "webSearch">> &
  Pick<components["schemas"]["EngineQuery"], "webSearch">;

export function createHandlers(spec: ToolSpec, call = createLlm()): Handlers {
  const urlSchema = spec.components?.schemas?.Url;
  if (!urlSchema) throw new Error("Missing bundled Url schema");
  const validUrl = validators(spec, false)(urlSchema);
  return {
    listEngines: async () => ({ data: deployment.map(({ engine }) => engine) }),
    queryEngine: async (request) => {
      const { engine, prompt, locale, country, webSearch } = request.body as Query;
      const entry = deployment.find(
        ({ engine: configured }) => configured.id === engine && configured.enabled,
      );
      if (!entry)
        throw new ToolProblem(422, "unsupported_engine", "/engine: Engine is not configured");

      const search = webSearch ?? entry.engine.webSearch;
      if (search && !entry.engine.webSearch)
        throw new ToolProblem(
          422,
          "unsupported_web_search",
          "/webSearch: Engine does not support web search",
        );

      const start = performance.now();
      const { parts, usage } = await call(entry, prompt, locale, country, search);
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
