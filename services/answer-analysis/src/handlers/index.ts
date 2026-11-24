import type { FastifyRequest } from "fastify";
import type { components } from "../../contract/types.js";
import type { Handlers } from "../app.js";
import { listAnalyzers, prepareAnalysis } from "../domain/analysis.js";
import { ToolProblem } from "../errors.js";
import { createLlm, UnexpectedServiceTier } from "../llm/adapter.js";
import { buildLunaBatch, luna, parseLunaBatch } from "../llm/luna.js";

type Schemas = components["schemas"];
type ValidatedRequest = Schemas["AnswerAnalysisRequest"] & {
  sentiment: Schemas["SentimentOptions"] &
    Required<Pick<Schemas["SentimentOptions"], "analyzers" | "onUnsupportedLanguage">>;
};

function sameSelector(left: Schemas["AnalyzerSelector"], right: Schemas["AnalyzerSelector"]) {
  return typeof left === "string" || typeof right === "string"
    ? left === right
    : left.provider === right.provider && left.model === right.model;
}

export function createHandlers({
  lunaEnabled,
  llm = createLlm(),
  reportFailedPrimaryUsage = (request, usage) =>
    request.log.warn({ usage }, "Usage from a failed primary sentiment analyzer"),
}: {
  lunaEnabled: boolean;
  llm?: ReturnType<typeof createLlm>;
  reportFailedPrimaryUsage?: (request: FastifyRequest, usage: Schemas["LlmUsage"]) => void;
}): Handlers {
  const catalog = listAnalyzers(lunaEnabled);
  return {
    listAnalyzers: async () => ({ data: catalog }),
    analyzeAnswer: async (request) => {
      const body = request.body as ValidatedRequest;
      const keys = new Set<string>();
      for (const [index, brand] of body.brands.entries()) {
        if (keys.has(brand.key))
          throw new ToolProblem(
            422,
            "duplicate_brand_key",
            "/brands/" + index + "/key repeats a brand key",
          );
        keys.add(brand.key);
      }

      // The registered request validator applies these HTTP defaults before this handler.
      const { analyzers, primary, language, onUnsupportedLanguage } = body.sentiment;
      const primaryIndex =
        primary === undefined
          ? -1
          : analyzers.findIndex((selector) => sameSelector(selector, primary));
      if (primary !== undefined && primaryIndex === -1)
        throw new ToolProblem(
          422,
          "invalid_primary",
          "/sentiment/primary must be in /sentiment/analyzers",
        );
      const selected = [];
      for (const [index, selector] of analyzers.entries()) {
        const analyzer = catalog.find((item) => sameSelector(selector, item.selector));
        if (!analyzer)
          throw new ToolProblem(
            422,
            "unsupported_analyzer",
            "/sentiment/analyzers/" +
              index +
              ": " +
              JSON.stringify(selector) +
              " is not advertised by this deployment",
          );
        selected.push(analyzer);
      }
      const outcome = prepareAnalysis(body, {
        analyzers: selected,
        primary: selected[primaryIndex]?.id,
        language,
        onUnsupportedLanguage: onUnsupportedLanguage,
      });
      if (outcome.unsupported) {
        const { index, language } = outcome.unsupported;
        const analyzer = selected[index];
        throw new ToolProblem(
          422,
          "unsupported_language",
          "/sentiment/analyzers/" +
            index +
            ": " +
            analyzer.id +
            " does not support " +
            (language ?? "undetermined language") +
            "; supported languages: " +
            analyzer.languages.join(", "),
        );
      }
      if (!outcome.needsLuna) return outcome.finish();
      let usage: Schemas["LlmUsage"] | undefined;
      try {
        const batch = buildLunaBatch(body.text, outcome.language, outcome.found);
        const completion = await llm(batch.request);
        usage = completion.usage;
        if (completion.refused || completion.finishReason !== "stop")
          throw new ToolProblem(
            503,
            "provider_unavailable",
            "Luna did not complete the sentiment batch",
          );
        return outcome.finish({ usage, verdicts: parseLunaBatch(completion.text, batch.keys) });
      } catch (error) {
        if (error instanceof UnexpectedServiceTier) {
          request.log.warn(
            {
              code: "llm_unexpected_service_tier",
              analyzer: luna.id,
              requestedTier: "default",
              reportedTier: error.reportedTier,
            },
            "Luna returned an unsupported pricing tier",
          );
        }
        if (!outcome.lunaIsPrimary) return outcome.finish({ usage });
        if (usage) reportFailedPrimaryUsage(request, usage);
        throw new ToolProblem(
          503,
          "provider_unavailable",
          "Primary sentiment analyzer failed",
          error instanceof ToolProblem ? error.retryAfter : undefined,
        );
      }
    },
  };
}
