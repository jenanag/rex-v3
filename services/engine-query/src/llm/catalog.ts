import type { components } from "../../contract/types.js";

const chatGpt = {
  id: "chatgpt",
  displayName: "ChatGPT",
  provider: "openai",
  model: "gpt-6-luna",
  webSearch: true,
  enabled: true,
} as const satisfies components["schemas"]["Engine"];

export const deployment = [
  {
    engine: chatGpt,
    // Standard, short-context USD per million tokens. Also microdollars per token.
    // https://developers.openai.com/api/docs/models/gpt-6-luna#pricing
    price: { input: 0.1, read: 0.01, write: 0.125, output: 0.5, searchMicros: 10_000 },
  },
];

export type Engine = (typeof deployment)[number];
