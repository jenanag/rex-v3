import type { Handlers } from "../app.js";
import { generateMarkup } from "../domain/generation.js";
import { validateMarkup } from "../domain/validation.js";
import { ToolProblem } from "../errors.js";
import type { components } from "../../contract/types.js";

export const handlers: Handlers = {
  generateSchemaMarkup: async (request) => {
    const result = await generateMarkup(
      request.body as components["schemas"]["SchemaMarkupRequest"],
    );
    if (!result)
      throw new ToolProblem(
        422,
        "no_usable_content",
        "The source contains no usable content fields.",
      );
    return result;
  },
  validateSchemaMarkup: async (request) =>
    validateMarkup(request.body as components["schemas"]["SchemaMarkupValidateRequest"]),
};
