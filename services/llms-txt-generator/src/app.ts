import { randomBytes, randomUUID } from "node:crypto";
import sensible from "@fastify/sensible";
import underPressure from "@fastify/under-pressure";
import Fastify, { LogController, type HTTPMethods, type RouteHandlerMethod } from "fastify";
import pino from "pino";
import type { Config } from "./config.js";
import { contractRoutes, responseMedia, validators, type ToolSpec } from "./contract.js";
import { ToolProblem, writeProblem } from "./errors.js";

declare module "fastify" {
  interface FastifyRequest {
    traceId: string;
  }
}

export type Handlers = Record<string, RouteHandlerMethod>;

export function createApp({
  spec,
  config,
  handlers,
  logs = true,
}: {
  spec: ToolSpec;
  config: Config;
  handlers: Handlers;
  logs?: boolean;
}) {
  const app = Fastify({
    ...(config.BODY_LIMIT_BYTES === undefined ? {} : { bodyLimit: config.BODY_LIMIT_BYTES }),
    ...(logs
      ? {
          loggerInstance: pino({
            level: config.LOG_LEVEL,
            base: {
              service: config.SERVICE_NAME,
              version: spec.info.version,
              env: config.NODE_ENV,
            },
          }),
        }
      : { logger: false }),
    logController: new LogController({ disableRequestLogging: true }),
    genReqId: (request) => {
      const id = request.headers["x-request-id"];
      return typeof id === "string" && /^[\w.:-]{1,128}$/.test(id) ? id : randomUUID();
    },
  });
  app.register(sensible);
  app.register(underPressure);
  app.decorateRequest("traceId", "");
  app.addHook("onRequest", async (request, reply) => {
    const parent = request.headers.traceparent;
    const trace =
      typeof parent === "string" && /^00-([a-f0-9]{32})-[a-f0-9]{16}-[a-f0-9]{2}$/.exec(parent);
    request.traceId = trace && !/^0+$/.test(trace[1]) ? trace[1] : randomBytes(16).toString("hex");
    request.log = request.log.child({ requestId: request.id, traceId: request.traceId });
    reply.header("x-request-id", request.id);
  });
  app.addHook("onResponse", async (request, reply) => {
    request.log.info(
      {
        method: request.method,
        route: request.routeOptions.url,
        operationId: request.routeOptions.config.operationId,
        statusCode: reply.statusCode,
        durationMs: reply.elapsedTime,
      },
      "Request completed",
    );
  });
  app.setErrorHandler((error, request, reply) =>
    writeProblem(config.PROBLEM_BASE_URI, error, request, reply),
  );
  app.setNotFoundHandler((request, reply) =>
    writeProblem(
      config.PROBLEM_BASE_URI,
      new ToolProblem(404, "not_found", "Route not found"),
      request,
      reply,
    ),
  );

  const compile = validators(spec, true);
  app.setValidatorCompiler(({ schema }) => compile(schema as Parameters<typeof compile>[0]));
  app.setSerializerCompiler(() => JSON.stringify);

  const health: RouteHandlerMethod = async () => ({
    status: "ok",
    service: config.SERVICE_NAME,
    version: spec.info.version,
  });

  for (const { method, path, op } of contractRoutes(spec)) {
    const handler =
      op.operationId === "getLiveness" || op.operationId === "getReadiness"
        ? health
        : handlers[op.operationId];
    if (!handler) throw new Error("Missing handler for " + op.operationId);
    const body = op.requestBody?.content["application/json"].schema;
    const response = Object.fromEntries(
      Object.entries(op.responses).flatMap(([status, definition]) => {
        const content = responseMedia(spec, definition);
        return content ? [[status, { content }]] : [];
      }),
    );
    app.route({
      method: method.toUpperCase() as HTTPMethods,
      url: path,
      config: { operationId: op.operationId },
      schema: { ...(body !== undefined ? { body } : {}), response },
      preValidation:
        body === undefined
          ? undefined
          : async (request) => {
              const contentType = request.headers["content-type"];
              if (contentType && !/^application\/json(?:\s*;|$)/i.test(contentType)) {
                throw new ToolProblem(415, "unsupported_media_type", "Expected application/json");
              }
            },
      handler,
    });
  }
  return app;
}

declare module "fastify" {
  interface FastifyContextConfig {
    operationId?: string;
  }
}
