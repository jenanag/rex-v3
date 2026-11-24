import { envSchema } from "env-schema";

export interface EngineConfig {
  ENGINE_QUERY_GROK_ENABLED: boolean;
}

export const toolEnvProperties = {
  ENGINE_QUERY_GROK_ENABLED: {
    type: "boolean",
    default: false,
    description: "Advertise and accept the opt-in Grok engine.",
  },
} as const;

export function loadEngineConfig(data: Record<string, unknown> = process.env) {
  return envSchema<EngineConfig>({
    env: false,
    data,
    schema: { type: "object", properties: toolEnvProperties },
  });
}
