import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { ErrorObject } from "ajv";
import Fastify, { type FastifyError, type FastifyInstance, type RouteHandlerMethod } from "fastify";
import glue from "fastify-openapi-glue";
import {
  loadSpec,
  responseMedia,
  validator,
  type Media,
  type Operation,
  type Spec,
} from "./contract.ts";
import { registerRoutes } from "./routes.ts";

export const responseExample = {
  language: null,
  languageSource: "undetermined",
  primaryFallback: false,
  analyzers: [],
  mentions: [
    {
      brandKey: "acme",
      position: 1,
      occurrences: 1,
      sentiment: null,
      sentimentScore: null,
      sentimentByAnalyzer: [],
      agreement: null,
      snippet: "Acme is mentioned.",
    },
  ],
  usage: [],
};
const health = async () => ({ status: "ok" });
const handlers: Record<string, RouteHandlerMethod> = {
  getLiveness: health,
  getReadiness: health,
  listAnalyzers: async () => ({ data: [] }),
  analyzeAnswer: async () => responseExample,
};

const escape = (key: string) => key.replaceAll("~", "~0").replaceAll("/", "~1");

function problemErrors(errors: ErrorObject[], part: string) {
  const prefix = part === "body" ? "" : part === "querystring" ? "#/query" : "#/header";
  const details = new Map<string, string>();
  for (const error of errors) {
    const { missingProperty, additionalProperty, unevaluatedProperty, propertyName } = error.params;
    const member =
      missingProperty ??
      additionalProperty ??
      unevaluatedProperty ??
      propertyName ??
      error.propertyName;
    const pointer =
      prefix + error.instancePath + (member === undefined ? "" : "/" + escape(member));
    if (!details.has(pointer)) details.set(pointer, error.message ?? error.keyword);
  }
  return [...details].map(([pointer, detail]) => ({ pointer, detail }));
}

export type Candidate = "loader" | "glue";
type Options = {
  candidate: Candidate;
  spec?: Spec;
  serialize?: "json" | "fast-json-stringify";
  measure?: (elapsedMs: number) => void;
  received?: (body: unknown) => void;
  result?: () => unknown;
};

export async function server(options: Options): Promise<FastifyInstance> {
  const { spec = loadSpec(), candidate, serialize = "json", measure, received, result } = options;
  const app = Fastify();
  const compile = validator(spec, true);
  app.setValidatorCompiler(({ schema, httpPart }) => {
    const validate = compile(schema as Media["schema"]);
    if (!measure || httpPart !== "body") return validate;
    return (value) => {
      const start = performance.now();
      const valid = validate(value);
      const elapsed = performance.now() - start;
      measure(elapsed);
      return valid ? true : { error: validate.errors! };
    };
  });
  if (serialize === "json") app.setSerializerCompiler(() => JSON.stringify);
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (!error.validation) return reply.send(error);
    return reply
      .code(400)
      .type("application/problem+json")
      .send({
        type: "https://problems.rex.invalid/validation_failed",
        title: "Request validation failed",
        status: 400,
        code: "validation_failed",
        traceId: randomBytes(16).toString("hex"),
        instance: request.url,
        errors: problemErrors(error.validation as ErrorObject[], error.validationContext ?? "body"),
      });
  });

  const handlerFor = (id: string): RouteHandlerMethod => {
    const handler = handlers[id];
    if (!handler) throw new Error("Missing handler for " + id);
    if (id !== "analyzeAnswer") return handler;
    return async (request) => {
      received?.(request.body);
      return result ? result() : responseExample;
    };
  };

  try {
    if (candidate === "glue") {
      app.register(glue, { specification: structuredClone(spec), operationResolver: handlerFor });
    } else {
      registerRoutes(app, spec, handlerFor);
    }
    await app.ready();
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}

export function responseValidator(spec: Spec, operation: Operation, status: string, type: string) {
  const media = responseMedia(spec, operation.responses[status]);
  return validator(spec, false)(media![type].schema);
}
