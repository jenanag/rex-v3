import type { Handlers } from "../app.js";
import { validators, type ToolSpec } from "../contract.js";
import { extractCitations, type ExtractionRequest } from "../domain/extract-citations.js";

export function createHandlers(spec: ToolSpec): Handlers {
  const compile = validators(spec, false);
  const check = {
    url: compile({ $ref: "#/components/schemas/Url" }),
    domain: compile({ $ref: "#/components/schemas/Domain" }),
  };
  return {
    extractCitations: async (request) => extractCitations(request.body as ExtractionRequest, check),
  };
}
