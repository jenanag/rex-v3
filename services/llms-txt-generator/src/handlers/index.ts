import type { components } from "../../contract/types.js";
import type { Handlers } from "../app.js";
import { validateLlmsTxt } from "../domain/validate-llms-txt.js";
import { ToolProblem } from "../errors.js";

export const handlers: Handlers = {
  describePage: async () => { throw new ToolProblem(501, "not_implemented", "Operation is not implemented"); },
  generateLlmsTxt: async () => { throw new ToolProblem(501, "not_implemented", "Operation is not implemented"); },
  validateLlmsTxt: async (request) =>
    validateLlmsTxt(request.body as components["schemas"]["LlmsTxtValidateRequest"]),
};
