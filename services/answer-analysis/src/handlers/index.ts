import type { components } from "../../contract/types.js";
import type { Handlers } from "../app.js";
import { analyze, isAdvertised, listAnalyzers } from "../domain/analysis.js";
import { ToolProblem } from "../errors.js";

type Schemas = components["schemas"];
type ValidatedRequest = Schemas["AnswerAnalysisRequest"] & {
  sentiment: Schemas["SentimentOptions"] &
    Required<Pick<Schemas["SentimentOptions"], "analyzers" | "onUnsupportedLanguage">>;
};

export const handlers: Handlers = {
  listAnalyzers: async () => ({ data: listAnalyzers() }),
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
    const selected = analyzers.filter(isAdvertised);
    if (selected.length !== analyzers.length) {
      const index = analyzers.findIndex((id) => !isAdvertised(id));
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

    const outcome = analyze(body, {
      analyzers: selected,
      primary,
      language,
      onUnsupportedLanguage: onUnsupportedLanguage,
    });
    if ("unsupported" in outcome) {
      const { index, language } = outcome.unsupported;
      const analyzer = listAnalyzers().find(({ id }) => id === selected[index])!;
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
    return outcome.result;
  },
};
