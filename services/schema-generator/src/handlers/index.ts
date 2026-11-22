import type { Handlers } from "../app.js";
import { ToolProblem } from "../errors.js";

export const handlers: Handlers = {
  generateSchemaMarkup: async () => { throw new ToolProblem(501, "not_implemented", "Operation is not implemented"); },
  validateSchemaMarkup: async () => { throw new ToolProblem(501, "not_implemented", "Operation is not implemented"); },
};
