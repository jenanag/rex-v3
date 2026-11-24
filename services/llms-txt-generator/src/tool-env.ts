import { envProperties } from "./env.js";

export const toolEnvProperties = {
  BODY_LIMIT_BYTES: {
    ...envProperties.BODY_LIMIT_BYTES,
    default: 12_582_912,
    description: "Fastify request body limit in bytes for all routes (ADR 0029).",
  },
} as const;

export const resolvedEnvProperties = { ...envProperties, ...toolEnvProperties } as const;
