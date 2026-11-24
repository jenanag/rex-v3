import type { Handlers } from "../app.js";
import { ToolProblem } from "../errors.js";

export const handlers: Handlers = {
  extractCitations: async () => { throw new ToolProblem(501, "not_implemented", "Operation is not implemented"); },
};
