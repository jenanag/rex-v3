import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import { envSchema } from "env-schema";
import OpenAI from "openai";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import { retryAfter } from "./retry-after.js";
import type { components } from "../../contract/types.js";
import { ToolProblem } from "../errors.js";
import { llmEnvProperties } from "./env.js";

type Provider = "openai" | "anthropic" | "google" | "perplexity" | "xai";
type LlmEnv = {
  LLM_MODE: "live" | "mock" | "record";
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  GEMINI_API_KEY?: string;
  PERPLEXITY_API_KEY?: string;
  XAI_API_KEY?: string;
};
export type LlmRequest = {
  provider: Provider;
  model: string;
  operation: string;
  prompt: string;
  maxOutputTokens: number;
  timeoutMs: number;
  price: {
    inputMicrosPerMillion: number;
    cachedInputMicrosPerMillion?: number;
    cacheWriteMicrosPerMillion?: number;
    outputMicrosPerMillion: number;
  };
  openAiChat?: {
    promptVersion: string;
    body: ChatCompletionCreateParamsNonStreaming;
  };
};
type Completion = {
  text: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  finishReason?: string;
  serviceTier?: string | null;
  refused?: boolean;
};

export class UnexpectedServiceTier extends ToolProblem {
  readonly reportedTier: string;

  constructor(tier: string) {
    super(503, "provider_unavailable", "LLM returned an unsupported pricing tier");
    // Keep diagnostics low-cardinality and avoid logging arbitrary provider data.
    this.reportedTier = ["auto", "flex", "scale", "priority", "fast"].includes(tier)
      ? tier
      : "unknown";
  }
}

function requireStandardTier(request: LlmRequest, tier: string | null | undefined) {
  if (request.openAiChat?.body.service_tier === "default" && tier != null && tier !== "default")
    throw new UnexpectedServiceTier(tier);
}

export function fixtureKey(request: LlmRequest) {
  const { provider, model, operation, prompt, maxOutputTokens } = request;
  const identity = request.openAiChat
    ? { provider, operation, timeoutMs: request.timeoutMs, ...request.openAiChat }
    : { provider, model, operation, prompt, maxOutputTokens };
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

function completion(value: Completion): Completion {
  const { inputTokens, outputTokens, cachedInputTokens = 0, cacheWriteTokens = 0 } = value;
  if (
    typeof value.text !== "string" ||
    ![inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    ) ||
    cachedInputTokens > inputTokens - cacheWriteTokens
  ) {
    throw new ToolProblem(503, "provider_unavailable", "LLM returned invalid completion or usage");
  }
  return value;
}

function key(value: string | undefined, provider: Provider) {
  if (!value)
    throw new ToolProblem(503, "provider_unavailable", "Missing credential for " + provider);
  return value;
}

async function generate(
  env: LlmEnv,
  request: LlmRequest,
  fetch?: typeof globalThis.fetch,
): Promise<Completion> {
  const { provider, model, prompt, maxOutputTokens, timeoutMs } = request;
  const signal = AbortSignal.timeout(timeoutMs);
  if (provider === "anthropic") {
    const client = new Anthropic({ apiKey: key(env.ANTHROPIC_API_KEY, provider), maxRetries: 0 });
    const reply = await client.messages.create(
      {
        model,
        max_tokens: maxOutputTokens,
        messages: [{ role: "user", content: prompt }],
      },
      { signal, timeout: timeoutMs },
    );
    return completion({
      text: reply.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
      inputTokens: reply.usage.input_tokens,
      outputTokens: reply.usage.output_tokens,
    });
  }
  if (provider === "google") {
    const client = new GoogleGenAI({ apiKey: key(env.GEMINI_API_KEY, provider) });
    const reply = await client.models.generateContent({
      model,
      contents: prompt,
      config: {
        maxOutputTokens,
        abortSignal: signal,
        httpOptions: { timeout: timeoutMs, retryOptions: { attempts: 1 } },
      },
    });
    return completion({
      text: reply.text ?? "",
      inputTokens: reply.usageMetadata?.promptTokenCount ?? NaN,
      outputTokens:
        reply.usageMetadata &&
        reply.usageMetadata.totalTokenCount !== undefined &&
        reply.usageMetadata.promptTokenCount !== undefined
          ? reply.usageMetadata.totalTokenCount - reply.usageMetadata.promptTokenCount
          : NaN,
    });
  }
  const baseURL =
    provider === "perplexity"
      ? "https://api.perplexity.ai"
      : provider === "xai"
        ? "https://api.x.ai/v1"
        : undefined;
  const credential =
    provider === "perplexity"
      ? env.PERPLEXITY_API_KEY
      : provider === "xai"
        ? env.XAI_API_KEY
        : env.OPENAI_API_KEY;
  const client = new OpenAI({ apiKey: key(credential, provider), baseURL, maxRetries: 0, fetch });
  const reply = await client.chat.completions.create(
    request.openAiChat?.body ?? {
      model,
      ...(provider === "openai"
        ? { max_completion_tokens: maxOutputTokens }
        : { max_tokens: maxOutputTokens }),
      messages: [{ role: "user", content: prompt }],
    },
    { signal, timeout: timeoutMs },
  );
  if (provider === "openai" && reply.model !== model) throw new Error("Unexpected provider model");

  requireStandardTier(request, reply.service_tier);
  const choice = reply.choices?.[0];
  const tokens = reply.usage;
  if (
    request.openAiChat &&
    tokens?.total_tokens !== (tokens?.prompt_tokens ?? NaN) + (tokens?.completion_tokens ?? NaN)
  ) {
    throw new ToolProblem(503, "provider_unavailable", "LLM returned inconsistent usage totals");
  }
  return completion({
    text: typeof choice?.message?.content === "string" ? choice.message.content : "",
    inputTokens: tokens?.prompt_tokens ?? NaN,
    outputTokens: tokens?.completion_tokens ?? NaN,
    ...(request.openAiChat && {
      cachedInputTokens: tokens?.prompt_tokens_details?.cached_tokens,
      cacheWriteTokens: tokens?.prompt_tokens_details?.cache_write_tokens,
      finishReason: choice?.finish_reason,
      serviceTier: reply.service_tier,
      refused: choice?.message?.refusal != null,
    }),
  });
}

function priceCompletion(result: Completion, price: LlmRequest["price"]) {
  const { cachedInputTokens = 0, cacheWriteTokens = 0 } = result;
  const rate = price.inputMicrosPerMillion;
  const uncached = result.inputTokens - cachedInputTokens - cacheWriteTokens;
  const total =
    BigInt(uncached) * BigInt(rate) +
    BigInt(cachedInputTokens) * BigInt(price.cachedInputMicrosPerMillion ?? rate) +
    BigInt(cacheWriteTokens) * BigInt(price.cacheWriteMicrosPerMillion ?? rate) +
    BigInt(result.outputTokens) * BigInt(price.outputMicrosPerMillion);
  const rounded = Number((total + 500_000n) / 1_000_000n);
  if (!Number.isSafeInteger(rounded) || total < 0n) throw new Error("Invalid LLM usage cost");
  return rounded;
}

async function recordCompletion(directory: string, file: string, result: Completion) {
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, ".record-" + randomUUID());
  try {
    await writeFile(temporary, JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function createLlm({
  data = process.env,
  fixtureDir = "test/fixtures/llm",
  fetch,
}: { data?: Record<string, unknown>; fixtureDir?: string; fetch?: typeof globalThis.fetch } = {}) {
  const env = envSchema<LlmEnv>({
    env: false,
    data,
    schema: {
      type: "object",
      properties: {
        ...llmEnvProperties,
        LLM_MODE: {
          ...llmEnvProperties.LLM_MODE,
          default: data.NODE_ENV === "test" ? "mock" : "live",
        },
      },
    },
  });
  return async (
    request: LlmRequest,
  ): Promise<
    Pick<Completion, "text" | "finishReason" | "refused"> & {
      usage: components["schemas"]["LlmUsage"];
    }
  > => {
    const file = join(fixtureDir, fixtureKey(request) + ".json");
    let result: Completion;
    if (env.LLM_MODE === "mock") {
      const replay: Completion = JSON.parse(await readFile(file, "utf8"));
      requireStandardTier(request, replay.serviceTier);
      result = completion(replay);
    } else {
      try {
        result = await generate(env, request, fetch);
      } catch (error) {
        if (error instanceof ToolProblem) throw error;
        throw new ToolProblem(503, "provider_unavailable", "LLM request failed", retryAfter(error));
      }
    }
    const costMicrosUsd = priceCompletion(result, request.price);
    if (env.LLM_MODE === "record") await recordCompletion(fixtureDir, file, result);
    return {
      text: result.text,
      ...(request.openAiChat && { finishReason: result.finishReason, refused: result.refused }),
      usage: {
        provider: request.provider,
        model: request.model,
        operation: request.operation,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costMicrosUsd,
      },
    };
  };
}
