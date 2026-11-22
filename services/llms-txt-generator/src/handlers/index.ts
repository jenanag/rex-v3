import type { Handlers } from "../app.js";
import { ToolProblem } from "../errors.js";

export const handlers: Handlers = {
  describePage: async () => { throw new ToolProblem(501, "not_implemented", "Operation is not implemented"); },
  generateLlmsTxt: async () => { throw new ToolProblem(501, "not_implemented", "Operation is not implemented"); },
  validateLlmsTxt: async () => { throw new ToolProblem(501, "not_implemented", "Operation is not implemented"); },
};
