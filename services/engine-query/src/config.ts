import { envSchema } from "env-schema";
import { addFormats } from "./contract.js";
import { envProperties } from "./env.js";

export interface Config {
  NODE_ENV: "development" | "test" | "production";
  SERVICE_NAME: string;
  PORT: number;
  LOG_LEVEL: string;
  PROBLEM_BASE_URI: string;
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  BODY_LIMIT_BYTES?: number;
}

export function loadConfig(data: Record<string, unknown> = process.env) {
  return envSchema<Config>({
    env: false,
    data,
    ajv: { customOptions: (ajv) => addFormats(ajv) },
    schema: { type: "object", properties: envProperties },
  });
}
