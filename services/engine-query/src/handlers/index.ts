import { performance } from "node:perf_hooks";
import type { components } from "../../contract/types.js";
import type { Handlers } from "../app.js";
import { validators, type ToolSpec } from "../contract.js";
import { renderAnswer } from "../domain/citations.js";
import { ToolProblem } from "../errors.js";
import { createLlm } from "../llm/adapter.js";
import { modelCatalog } from "../llm/catalog.js";

type Query = components["schemas"]["EngineQuery"] & { locale: string; country: string };

export function createHandlers(spec: ToolSpec, call = createLlm()): Handlers {
  const urlSchema = spec.components?.schemas?.Url;
  if (!urlSchema) throw new Error("Missing bundled Url schema");
  const validUrl = validators(spec, false)(urlSchema);
  return {
    listEngines: async () => ({
      data: modelCatalog.map(({ displayName, webSearch, provider, model }) => ({
        displayName,
        webSearch,
        provider,
        model,
      })),
    }),
    queryEngine: async (request) => {
      const { provider, model, prompt, locale, country, webSearch } = request.body as Query;
      const selected = modelCatalog.find(
        (allowed) => allowed.provider === provider && allowed.model === model,
      );
      if (!selected)
        throw new ToolProblem(
          422,
          "unsupported_model",
          "/provider and /model: Pair is not allowed by this deployment",
        );

      if (webSearch && !selected.webSearch)
        throw new ToolProblem(
          422,
          "unsupported_web_search",
          "/webSearch: Provider/model pair does not support web search",
        );

      const start = performance.now();
      const { parts, usage } = await call(selected, prompt, locale, country, webSearch);
      return {
        answer: {
          provider: selected.provider,
          model: selected.model,
          ...renderAnswer(parts, validUrl),
          latencyMs: Math.round(performance.now() - start),
        },
        usage: [usage],
      };
    },
  };
}
