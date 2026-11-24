import {
  BlockedReason,
  GoogleGenAI,
  ServiceTier,
  ThinkingLevel,
  type GenerateContentResponse,
} from "@google/genai";
import type { components } from "../../contract/types.js";
import type { TextPart } from "../domain/citations.js";
import type { GeminiEngine } from "./catalog.js";
import { count } from "./usage.js";

const baseUrl = "https://generativelanguage.googleapis.com";
const apiVersion = "v1";
export const geminiEndpoint = (model: string) =>
  `${baseUrl}/${apiVersion}/models/${model}:generateContent`;

export function geminiRequest(model: string, prompt: string, locale: string, country: string) {
  return {
    model,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: {
      systemInstruction:
        "Answer in Markdown. Prefer locale " +
        locale +
        ". Use " +
        country +
        " as a regional relevance hint.",
      serviceTier: ServiceTier.STANDARD,
      maxOutputTokens: 2_048,
      thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL, includeThoughts: false },
    },
  };
}

export async function generateGemini(
  request: ReturnType<typeof geminiRequest>,
  apiKey: string | undefined,
  timeout: number,
  fetch: typeof globalThis.fetch = globalThis.fetch,
) {
  if (!apiKey) throw new Error("Missing provider credential");

  let headers: Headers | undefined;
  const client = new GoogleGenAI({
    apiKey,
    vertexai: false,
    httpOptions: {
      baseUrl,
      apiVersion,
      timeout,
      retryOptions: { attempts: 1 },
      fetch: async (input, init) => {
        const response = await fetch(input, { ...init, redirect: "error" });
        // ApiError carries the status and message, but drops response headers.
        if (!response.ok) headers = response.headers;
        return response;
      },
    },
  });
  try {
    return await client.models.generateContent({
      ...request,
      config: { ...request.config, abortSignal: AbortSignal.timeout(timeout) },
    });
  } catch (error) {
    if (headers)
      throw Object.assign(new Error("Gemini request failed", { cause: error }), { headers });
    throw error;
  }
}

function optionalCount(value: unknown) {
  return value === undefined ? 0 : count(value);
}

function geminiUsage(
  metadata: GenerateContentResponse["usageMetadata"],
  { engine, price }: GeminiEngine,
): components["schemas"]["LlmUsage"] {
  // The SDK preserves this REST field but its v3.6.1 type does not declare it.
  const tier = (metadata as typeof metadata & { serviceTier?: unknown })?.serviceTier;
  if (tier !== undefined && tier !== ServiceTier.UNSPECIFIED && tier !== ServiceTier.STANDARD)
    throw new Error("Unexpected provider service tier");

  const inputTokens = count(metadata?.promptTokenCount);
  const candidates = count(metadata?.candidatesTokenCount);
  const total = count(metadata?.totalTokenCount);
  const reads = optionalCount(metadata?.cachedContentTokenCount);
  const thoughts = optionalCount(metadata?.thoughtsTokenCount);
  const outputTokens = candidates + thoughts;
  if (
    reads > inputTokens ||
    optionalCount(metadata?.toolUsePromptTokenCount) !== 0 ||
    total !== inputTokens + outputTokens
  )
    throw new Error("Inconsistent provider usage");

  const hundredths =
    BigInt(inputTokens - reads) * BigInt(price.input) +
    BigInt(reads) * BigInt(price.read) +
    BigInt(outputTokens) * BigInt(price.output);
  return {
    provider: engine.provider,
    model: engine.model,
    operation: "answer_prompt",
    inputTokens,
    outputTokens,
    costMicrosUsd: count(Number((hundredths + 50n) / 100n)),
  };
}

export function geminiAnswer(
  response: GenerateContentResponse,
  entry: GeminiEngine,
): { parts: TextPart[]; usage: components["schemas"]["LlmUsage"] } {
  if (response.modelVersion !== entry.engine.model) throw new Error("Unexpected provider model");

  const block = response.promptFeedback?.blockReason;
  const [candidate] = response.candidates ?? [];
  if (
    (block && block !== BlockedReason.BLOCKED_REASON_UNSPECIFIED) ||
    response.candidates?.length !== 1 ||
    candidate?.finishReason !== "STOP"
  )
    throw new Error("Provider response did not complete");

  const visible = candidate.content?.parts?.filter((part) => part.thought !== true) ?? [];
  if (visible.some((part) => typeof part.text !== "string"))
    throw new Error("Invalid provider text part");

  const text = visible.map((part) => part.text).join("");
  if (!text.trim()) throw new Error("Provider answer was blank");
  return { parts: [{ text, annotations: [] }], usage: geminiUsage(response.usageMetadata, entry) };
}
