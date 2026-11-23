import { STATUS_CODES } from "node:http";
import type { ErrorObject } from "ajv";
import type { FastifyReply, FastifyRequest } from "fastify";

export class ToolProblem extends Error {
  constructor(
    readonly statusCode: number,
    readonly problemCode: string,
    detail: string,
    readonly retryAfter?: string,
  ) {
    super(detail);
  }
}

const escape = (value: string) => value.replaceAll("~", "~0").replaceAll("/", "~1");

function fields(errors: ErrorObject[]) {
  const result = new Map<string, string>();
  for (const error of errors) {
    const { missingProperty, additionalProperty, unevaluatedProperty, propertyName } = error.params;
    const member =
      missingProperty ??
      additionalProperty ??
      unevaluatedProperty ??
      propertyName ??
      error.propertyName;
    const pointer = error.instancePath + (member === undefined ? "" : "/" + escape(member));
    if (!result.has(pointer)) result.set(pointer, error.message ?? error.keyword);
  }
  return [...result].map(([pointer, detail]) => ({ pointer, detail }));
}

export function writeProblem(
  base: string,
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const cause = error && typeof error === "object" ? error : {};
  const validation =
    "validation" in cause && Array.isArray(cause.validation) ? cause.validation : undefined;
  const candidate = "statusCode" in cause ? cause.statusCode : undefined;
  const status =
    typeof candidate === "number" && candidate >= 400 && candidate <= 599 ? candidate : 500;
  const code =
    error instanceof ToolProblem
      ? error.problemCode
      : status === 400
        ? "validation_failed"
        : ({
            404: "not_found",
            413: "payload_too_large",
            415: "unsupported_media_type",
            429: "rate_limited",
            503: "service_unavailable",
          }[status] ?? "internal_error");
  if (status >= 500) request.log.error({ statusCode: status, code }, "Request failed");
  if (error instanceof ToolProblem && error.retryAfter)
    reply.header("Retry-After", error.retryAfter);
  return reply
    .code(status)
    .type("application/problem+json")
    .send({
      type: base.replace(/\/$/, "") + "/" + code,
      title: STATUS_CODES[status] ?? "Request failed",
      status,
      code,
      traceId: request.traceId,
      instance: request.url.split("?")[0],
      ...(error instanceof ToolProblem ? { detail: error.message } : {}),
      ...(status === 400
        ? {
            errors: validation
              ? fields(validation as ErrorObject[])
              : [{ pointer: "", detail: "Invalid JSON request body" }],
          }
        : {}),
    });
}
