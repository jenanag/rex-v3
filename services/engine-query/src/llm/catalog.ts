import type { components } from "../../contract/types.js";

const chatGpt = {
  id: "chatgpt",
  displayName: "ChatGPT",
  provider: "openai",
  model: "gpt-6-luna",
  webSearch: true,
  enabled: true,
} as const satisfies components["schemas"]["Engine"];

const grok = {
  id: "grok",
  displayName: "Grok",
  provider: "xai",
  model: "grok-4.3",
  webSearch: true,
  enabled: true,
} as const satisfies components["schemas"]["Engine"];

const chatGptEntry = {
  engine: chatGpt,
  // Standard, short-context USD per million tokens. Also microdollars per token.
  // https://developers.openai.com/api/docs/models/gpt-6-luna#pricing
  price: { input: 0.1, read: 0.01, write: 0.125, output: 0.5, searchMicros: 10_000 },
};

const grokEntry = {
  engine: grok,
  // Standard global rates in integer ticks per token or billable tool call.
  // https://docs.x.ai/developers/pricing
  price: {
    longContextAt: 200_000,
    shortContext: { input: 12_500n, read: 2_000n, output: 25_000n },
    longContext: { input: 25_000n, read: 4_000n, output: 50_000n },
    webCallTicks: 50_000_000n,
  },
};

export type Engine = typeof chatGptEntry | typeof grokEntry;

export function deployment(grokEnabled: boolean): Engine[] {
  return grokEnabled ? [chatGptEntry, grokEntry] : [chatGptEntry];
}
