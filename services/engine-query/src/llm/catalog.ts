export const deployment = [
  {
    displayName: "ChatGPT",
    webSearch: true,
    provider: "openai",
    model: "gpt-6-luna",
    // Standard, short-context USD per million tokens. Also microdollars per token.
    // https://developers.openai.com/api/docs/models/gpt-6-luna#pricing
    price: { input: 0.1, read: 0.01, write: 0.125, output: 0.5, searchMicros: 10_000 },
  },
  {
    displayName: "Gemini",
    webSearch: false,
    provider: "google",
    model: "gemini-3.5-flash-lite",
    // Standard text rates in hundredths of a microdollar per token.
    // https://aistudio.google.com/docs/pricing#gemini-3.5-flash-lite
    price: { input: 30, read: 3, output: 250 },
  },
] as const;

export type EngineModel = (typeof deployment)[number];
export type OpenAiModel = Extract<EngineModel, { provider: "openai" }>;
export type GeminiModel = Extract<EngineModel, { provider: "google" }>;
