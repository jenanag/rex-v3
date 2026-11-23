import type { components } from "../../contract/types.js";
import type { Handlers } from "../app.js";
import type { Config } from "../config.js";
import { describePageWithLlm } from "../domain/describe-page-llm.js";
import { describePageExtractively } from "../domain/describe-page.js";
import { generateLlmsTxt } from "../domain/generate-llms-txt.js";
import { validateLlmsTxt } from "../domain/validate-llms-txt.js";
import { createLlm } from "../llm/adapter.js";

export function createHandlers(config: Config, llm = createLlm()): Handlers {
  return {
    describePage: async (request) => {
      const body = request.body as components["schemas"]["PageEntryRequest"];
      return body.summarizer === "extractive"
        ? describePageExtractively(body)
        : describePageWithLlm(body, config.LLMS_TXT_GENERATOR_DEFAULT_MODEL, llm);
    },
    generateLlmsTxt: async (request) =>
      generateLlmsTxt(request.body as components["schemas"]["LlmsTxtRequest"]),
    validateLlmsTxt: async (request) =>
      validateLlmsTxt(request.body as components["schemas"]["LlmsTxtValidateRequest"]),
  };
}
