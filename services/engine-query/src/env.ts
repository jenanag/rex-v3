export const envProperties = {
  NODE_ENV: {
    type: "string",
    enum: ["development", "test", "production"],
    default: "development",
    description: "Runtime environment.",
  },
  SERVICE_NAME: {
    type: "string",
    minLength: 1,
    default: "engine-query",
    description: "Service name in logs and probes.",
  },
  PORT: {
    type: "integer",
    minimum: 1,
    maximum: 65535,
    default: 8080,
    description: "HTTP listen port.",
  },
  LOG_LEVEL: {
    type: "string",
    enum: ["trace", "debug", "info", "warn", "error", "fatal", "silent"],
    default: "info",
    description: "Structured log level.",
  },
  PROBLEM_BASE_URI: {
    type: "string",
    format: "uri",
    pattern: "^https?://",
    default: "https://problems.rex.invalid",
    description: "Base URI for problem types.",
  },
  OTEL_EXPORTER_OTLP_ENDPOINT: {
    type: "string",
    format: "uri",
    pattern: "^https?://",
    description: "OTLP collector. Export is off when unset.",
  },
  BODY_LIMIT_BYTES: {
    type: "integer",
    minimum: 1,
    description: "Optional override of the Fastify request-body limit.",
  },
} as const;
