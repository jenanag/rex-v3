import type { FastifyInstance, HTTPMethods, RouteHandlerMethod } from "fastify";
import { type Operation, type Spec, responseMedia } from "./contract.ts";

const methods = new Set(["get", "post", "put", "patch", "delete", "head", "options", "trace"]);

export function registerRoutes(
  app: FastifyInstance,
  spec: Spec,
  handlerFor: (operationId: string) => RouteHandlerMethod,
) {
  for (const [url, path] of Object.entries(spec.paths)) {
    if (path.parameters?.length || "$ref" in path || url.includes("{")) {
      throw new Error("Unsupported tool path item: " + url);
    }
    for (const [method, candidate] of Object.entries(path)) {
      if (!methods.has(method)) continue;
      const operation = candidate as Operation;
      if (
        operation.parameters?.length ||
        (operation.requestBody &&
          (!operation.requestBody.required ||
            Object.keys(operation.requestBody.content).join() !== "application/json"))
      ) {
        throw new Error("Unsupported tool request: " + operation.operationId);
      }
      const body = operation.requestBody?.content["application/json"].schema;
      const response = Object.fromEntries(
        Object.entries(operation.responses).flatMap(([status, definition]) => {
          const media = responseMedia(spec, definition);
          if (!media) return [];
          return [[status, { content: media }]];
        }),
      );
      app.route({
        method: method.toUpperCase() as HTTPMethods,
        url,
        schema: { ...(body !== undefined ? { body } : {}), response },
        handler: handlerFor(operation.operationId),
      });
    }
  }
}
