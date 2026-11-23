import type { components } from "../../contract/types.js";
import type { Handlers } from "../app.js";
import { describePageExtractively } from "../domain/describe-page.js";
import { generateLlmsTxt } from "../domain/generate-llms-txt.js";
import { validateLlmsTxt } from "../domain/validate-llms-txt.js";
import { ToolProblem } from "../errors.js";

export const handlers: Handlers = {
  describePage: async (request) => {
    const body = request.body as components["schemas"]["PageEntryRequest"];
    if (body.summarizer === "extractive") return describePageExtractively(body);
    throw new ToolProblem(501, "not_implemented", "Operation is not implemented");
  },
  generateLlmsTxt: async (request) =>
    generateLlmsTxt(request.body as components["schemas"]["LlmsTxtRequest"]),
  validateLlmsTxt: async (request) =>
    validateLlmsTxt(request.body as components["schemas"]["LlmsTxtValidateRequest"]),
};
