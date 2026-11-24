import { envProperties } from "./env.js";

export const toolEnvProperties = {
  BODY_LIMIT_BYTES: { ...envProperties.BODY_LIMIT_BYTES, default: 3_145_728 },
  ANSWER_ANALYSIS_LUNA_ENABLED: {
    type: "boolean",
    default: false,
    description: "Advertise and accept the opt-in GPT-6 Luna analyzer.",
  },
  ANSWER_ANALYSIS_GEMINI_ENABLED: {
    type: "boolean",
    default: false,
    description: "Advertise and accept the opt-in Gemini 2.5 Flash-Lite analyzer.",
  },
} as const;
