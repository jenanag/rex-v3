import type { components } from "../../contract/types.js";
import type { LlmRequest } from "./adapter.js";
import { fitBatch, instructions, maxOutputTokens, schema, type Mentions } from "./batch.js";

type Schemas = components["schemas"];

export const luna = {
  id: "llm:openai/gpt-6-luna",
  kind: "llm",
  languages: ["*"],
  description: "Classifies sentiment for mentioned brands with OpenAI GPT-6 Luna.",
} satisfies Schemas["Analyzer"];

const model = "gpt-6-luna";
const promptVersion = "answer-analysis-luna-v1";
export function buildLunaBatch(text: string, language: string | null, mentions: Mentions) {
  const chat: NonNullable<LlmRequest["openAiChat"]> = {
    promptVersion,
    body: {
      model,
      reasoning_effort: "none",
      service_tier: "default",
      store: false,
      max_completion_tokens: maxOutputTokens,
      messages: [
        { role: "developer", content: instructions },
        { role: "user", content: "" },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "brand_sentiment", strict: true, schema },
      },
    },
  };
  const keys = fitBatch(text, language, mentions, (evidence) => {
    chat.body.messages[1] = { role: "user", content: evidence };
    return Buffer.byteLength(JSON.stringify(chat.body), "utf8");
  });

  const request: LlmRequest = {
    provider: "openai",
    model,
    operation: "classify_sentiment",
    prompt: instructions,
    maxOutputTokens,
    timeoutMs: 60_000,
    // OpenAI Standard, short context. See the answer-analysis service doc.
    price: {
      inputMicrosPerMillion: 100_000,
      cachedInputMicrosPerMillion: 10_000,
      cacheWriteMicrosPerMillion: 125_000,
      outputMicrosPerMillion: 500_000,
    },
    openAiChat: chat,
  };
  return { request, keys };
}
