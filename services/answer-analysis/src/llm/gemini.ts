import {
  BlockedReason,
  GoogleGenAI,
  ServiceTier,
  type GenerateContentResponse,
} from "@google/genai";
import type { components } from "../../contract/types.js";
import type { Completion, LlmRequest } from "./adapter.js";
import {
  fitBatch,
  instructions,
  maxOutputTokens,
  requestLimit,
  schema,
  type Mentions,
} from "./batch.js";

const model = "gemini-2.5-flash-lite";
const baseUrl = "https://generativelanguage.googleapis.com";
const apiVersion = "v1";
const endpoint = `${baseUrl}/${apiVersion}/models/${model}:generateContent`;

// Keep the rationale length check local. The provider accepts the nullable type.
const providerSchema = {
  ...schema,
  properties: {
    results: {
      ...schema.properties.results,
      items: {
        ...schema.properties.results.items,
        properties: {
          ...schema.properties.results.items.properties,
          rationale: { type: ["string", "null"] },
        },
      },
    },
  },
};

export const gemini = {
  id: "llm:google/gemini-2.5-flash-lite",
  kind: "llm",
  languages: ["*"],
  description: "Classifies sentiment for mentioned brands with Google Gemini 2.5 Flash-Lite.",
} satisfies components["schemas"]["Analyzer"];

function geminiBody(evidence: string) {
  return {
    contents: [{ role: "user", parts: [{ text: evidence }] }],
    systemInstruction: { role: "user", parts: [{ text: instructions }] },
    serviceTier: ServiceTier.STANDARD,
    generationConfig: {
      maxOutputTokens,
      thinkingConfig: { thinkingBudget: 0, includeThoughts: false },
      responseMimeType: "application/json",
      responseJsonSchema: providerSchema,
    },
  };
}

export type GeminiGenerate = {
  endpoint: string;
  promptVersion: string;
  body: ReturnType<typeof geminiBody>;
};

export function buildGeminiBatch(text: string, language: string | null, mentions: Mentions) {
  const generate = { endpoint, promptVersion: "answer-analysis-gemini-v1", body: geminiBody("") };
  const keys = fitBatch(text, language, mentions, (evidence) => {
    generate.body.contents[0].parts[0].text = evidence;
    return Buffer.byteLength(JSON.stringify(generate.body), "utf8");
  });
  const request: LlmRequest = {
    provider: "google",
    model,
    operation: "classify_sentiment",
    prompt: instructions,
    maxOutputTokens,
    timeoutMs: 60_000,
    // Standard text rates. https://aistudio.google.com/docs/pricing#gemini-2.5-flash-lite
    price: {
      inputMicrosPerMillion: 100_000,
      cachedInputMicrosPerMillion: 10_000,
      outputMicrosPerMillion: 400_000,
    },
    geminiGenerate: generate,
  };
  return { request, keys };
}

export async function generateGemini(
  request: GeminiGenerate,
  apiKey: string,
  timeout: number,
  signal: AbortSignal,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<Completion> {
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
        const wire = new Request(input, { ...init, redirect: "error" });
        if (
          wire.url !== request.endpoint ||
          Buffer.byteLength(await wire.clone().text(), "utf8") > requestLimit
        )
          throw new Error("Invalid Gemini wire request");
        const response = await fetch(wire);
        // ApiError drops the response headers.
        if (!response.ok) headers = response.headers;
        return response;
      },
    },
  });
  const { contents, generationConfig, systemInstruction, serviceTier } = request.body;
  let reply: GenerateContentResponse;
  try {
    reply = await client.models.generateContent({
      model,
      contents,
      config: { ...generationConfig, systemInstruction, serviceTier, abortSignal: signal },
    });
  } catch (error) {
    if (headers)
      throw Object.assign(new Error("Gemini request failed", { cause: error }), { headers });
    throw error;
  }
  return normalize(reply);
}

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("Invalid Gemini usage count");
  return value;
}

function optionalCount(value: unknown): number {
  return value === undefined ? 0 : count(value);
}

function normalize(reply: GenerateContentResponse): Completion {
  if (reply.modelVersion !== model) throw new Error("Unexpected Gemini model");
  const metadata = reply.usageMetadata;
  // The pinned SDK retains the REST tier field but does not type it.
  const serviceTier = (metadata as typeof metadata & { serviceTier?: string | null })?.serviceTier;
  const inputTokens = count(metadata?.promptTokenCount);
  const cachedInputTokens = optionalCount(metadata?.cachedContentTokenCount);
  const outputTokens =
    count(metadata?.candidatesTokenCount) + optionalCount(metadata?.thoughtsTokenCount);
  if (
    cachedInputTokens > inputTokens ||
    optionalCount(metadata?.toolUsePromptTokenCount) !== 0 ||
    count(metadata?.totalTokenCount) !== inputTokens + outputTokens
  )
    throw new Error("Inconsistent Gemini usage totals");

  const candidates = Array.isArray(reply.candidates) ? reply.candidates : [];
  const [candidate] = candidates;
  const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
  const visible = parts.filter((part) => part?.thought !== true);
  const usableParts = visible.every((part) => typeof part?.text === "string");
  const text = usableParts ? visible.map((part) => part.text).join("") : "";
  const block = reply.promptFeedback?.blockReason;
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    serviceTier,
    text,
    finishReason: candidate?.finishReason,
    refused:
      candidates.length !== 1 ||
      candidate?.safetyRatings?.some((rating) => rating?.blocked === true) === true ||
      (block !== undefined && block !== BlockedReason.BLOCKED_REASON_UNSPECIFIED) ||
      !text.trim(),
  };
}
