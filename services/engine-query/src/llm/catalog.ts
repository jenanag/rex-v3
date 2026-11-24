import type { components } from "../../contract/types.js";

const chatGpt = {
  id: "chatgpt",
  displayName: "ChatGPT",
  provider: "openai",
  model: "gpt-6-luna",
  webSearch: true,
  enabled: true,
} as const satisfies components["schemas"]["Engine"];

const gemini = {
  id: "gemini",
  displayName: "Gemini",
  provider: "google",
  model: "gemini-3.5-flash-lite",
  webSearch: false,
  enabled: true,
} as const satisfies components["schemas"]["Engine"];

export const deployment = [
  {
    kind: "openai",
    engine: chatGpt,
    // Standard, short-context USD per million tokens. Also microdollars per token.
    // https://developers.openai.com/api/docs/models/gpt-6-luna#pricing
    price: { input: 0.1, read: 0.01, write: 0.125, output: 0.5, searchMicros: 10_000 },
  },
  {
    kind: "google",
    engine: gemini,
    // Standard text rates in hundredths of a microdollar per token.
    // https://aistudio.google.com/docs/pricing#gemini-3.5-flash-lite
    price: { input: 30, read: 3, output: 250 },
  },
] as const;

export type Engine = (typeof deployment)[number];
export type OpenAiEngine = Extract<Engine, { kind: "openai" }>;
export type GeminiEngine = Extract<Engine, { kind: "google" }>;
