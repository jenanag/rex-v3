import type { FastifyRequest } from "fastify";
import type { components } from "../../contract/types.js";
import type { Handlers } from "../app.js";
import { listAnalyzers, prepareAnalysis, type LlmOutcome } from "../domain/analysis.js";
import { ToolProblem } from "../errors.js";
import { createLlm, UnexpectedServiceTier } from "../llm/adapter.js";
import { parseVerdicts } from "../llm/batch.js";
import { buildGeminiBatch, gemini } from "../llm/gemini.js";
import { buildLunaBatch, luna } from "../llm/luna.js";

const providers = {
  [luna.id]: { build: buildLunaBatch, name: "Luna", tier: "default", finish: "stop" },
  [gemini.id]: { build: buildGeminiBatch, name: "Gemini", tier: "standard", finish: "STOP" },
};

type Schemas = components["schemas"];
type ValidatedRequest = Schemas["AnswerAnalysisRequest"] & {
  sentiment: Schemas["SentimentOptions"] &
    Required<Pick<Schemas["SentimentOptions"], "analyzers" | "onUnsupportedLanguage">>;
};

export function createHandlers({
  lunaEnabled,
  geminiEnabled = false,
  llm = createLlm(),
  reportFailedPrimaryUsage = (request, usage) =>
    request.log.warn({ usage }, "Usage from a failed primary sentiment analyzer"),
}: {
  lunaEnabled: boolean;
  geminiEnabled?: boolean;
  llm?: ReturnType<typeof createLlm>;
  reportFailedPrimaryUsage?: (request: FastifyRequest, usage: Schemas["LlmUsage"]) => void;
}): Handlers {
  const catalog = listAnalyzers(lunaEnabled, geminiEnabled);
  const byId = new Map(catalog.map((analyzer) => [analyzer.id, analyzer]));
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
      if (primary !== undefined && !analyzers.includes(primary))
        throw new ToolProblem(
          422,
          "invalid_primary",
          "/sentiment/primary must be in /sentiment/analyzers",
        );
      const index = analyzers.findIndex((id) => !byId.has(id));
      if (index !== -1) {
        throw new ToolProblem(
          422,
          "unsupported_analyzer",
          "/sentiment/analyzers/" +
            index +
            ": " +
            analyzers[index] +
            " is not advertised by this deployment",
        );
      }

      const selected = analyzers.map((id) => byId.get(id)!);
      const outcome = prepareAnalysis(body, {
        analyzers: selected,
        primary,
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
      if (!outcome.llmAnalyzers.length) return outcome.finish();

      const completed = await Promise.all(
        outcome.llmAnalyzers.map(async ({ id }) => {
          const provider = providers[id];
          let usage: Schemas["LlmUsage"] | undefined;
          try {
            const batch = provider.build(body.text, outcome.language, outcome.found);
            const completion = await llm(batch.request);
            usage = completion.usage;
            if (completion.refused || completion.finishReason !== provider.finish)
              throw new ToolProblem(
                503,
                "provider_unavailable",
                provider.name + " did not complete the sentiment batch",
              );
            const verdicts = parseVerdicts(completion.text, batch.keys, provider.name);
            return { id, result: { usage, verdicts } satisfies LlmOutcome };
          } catch (error) {
            if (error instanceof UnexpectedServiceTier) {
              request.log.warn(
                {
                  code: "llm_unexpected_service_tier",
                  analyzer: id,
                  requestedTier: provider.tier,
                  reportedTier: error.reportedTier,
                },
                provider.name + " returned an unsupported pricing tier",
              );
            }
            return { id, result: { usage } satisfies LlmOutcome, error };
          }
        }),
      );

      const failedPrimary = completed.find(
        (entry) => entry.id === outcome.primaryId && "error" in entry,
      );
      if (failedPrimary) {
        for (const { result } of completed) {
          if (result.usage) reportFailedPrimaryUsage(request, result.usage);
        }
        throw new ToolProblem(
          503,
          "provider_unavailable",
          "Primary sentiment analyzer failed",
          failedPrimary.error instanceof ToolProblem ? failedPrimary.error.retryAfter : undefined,
        );
      }
      return outcome.finish(new Map(completed.map(({ id, result }) => [id, result])));
    },
  };
}
