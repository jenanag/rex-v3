import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import { envSchema } from "env-schema";
import OpenAI from "openai";
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
  reasoningEffort?: "none";
  price: {
    inputMicrosPerMillion: number;
    cachedInputMicrosPerMillion?: number;
    cacheWriteMicrosPerMillion?: number;
    outputMicrosPerMillion: number;
  };
};
type Completion = {
  text: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
};

export function fixtureKey(request: LlmRequest) {
  const { provider, model, operation, prompt, maxOutputTokens, reasoningEffort } = request;
  return createHash("sha256")
    .update(
      JSON.stringify({ provider, model, operation, prompt, maxOutputTokens, reasoningEffort }),
    )
    .digest("hex");
}

function completion(value: Completion): Completion {
  const { text, inputTokens, outputTokens, cachedInputTokens = 0, cacheWriteTokens = 0 } = value;
  if (
    typeof text !== "string" ||
    ![inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    ) ||
    cachedInputTokens + cacheWriteTokens > inputTokens
  ) {
    throw new Error("Invalid completion or token counts");
  }
  return { text, inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens };
}

function key(value: string | undefined, provider: Provider) {
  if (!value)
    throw new ToolProblem(503, "provider_unavailable", "Missing credential for " + provider);
  return value;
}

async function generate(env: LlmEnv, request: LlmRequest): Promise<Completion> {
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
  const client = new OpenAI({ apiKey: key(credential, provider), baseURL, maxRetries: 0 });
  const reply = await client.chat.completions.create(
    {
      model,
      ...(provider === "openai"
        ? { max_completion_tokens: maxOutputTokens }
        : { max_tokens: maxOutputTokens }),
      ...(provider === "openai" && request.reasoningEffort !== undefined
        ? { reasoning_effort: request.reasoningEffort, service_tier: "default" }
        : {}),
      messages: [{ role: "user", content: prompt }],
    },
    { signal, timeout: timeoutMs },
  );
  if (provider === "openai" && reply.model !== model) throw new Error("Unexpected provider model");

  const content = reply.choices?.[0]?.message?.content;
  return completion({
    text: typeof content === "string" ? content : "",
    inputTokens: reply.usage?.prompt_tokens ?? NaN,
    outputTokens: reply.usage?.completion_tokens ?? NaN,
    ...(provider === "openai"
      ? {
          cachedInputTokens: reply.usage?.prompt_tokens_details?.cached_tokens,
          cacheWriteTokens: reply.usage?.prompt_tokens_details?.cache_write_tokens,
        }
      : {}),
  });
}

const months = "jan feb mar apr may jun jul aug sep oct nov dec".split(" ");
const weekdays = "sunday monday tuesday wednesday thursday friday saturday".split(" ");

function validHttpDate(value: string): boolean {
  // RFC 9110 §5.6.7 requires recipients to accept all three HTTP-date formats.
  const parts =
    /^(?<weekday>[a-z]{3}), (?<day>\d{2}) (?<month>[a-z]{3}) (?<year>\d{4}) (?<time>\d{2}:\d{2}:\d{2}) GMT$/i.exec(
      value,
    )?.groups ??
    /^(?<weekday>[a-z]+), (?<day>\d{2})-(?<month>[a-z]{3})-(?<year>\d{2}) (?<time>\d{2}:\d{2}:\d{2}) GMT$/i.exec(
      value,
    )?.groups ??
    /^(?<weekday>[a-z]{3}) (?<month>[a-z]{3}) (?<day>\d{2}| \d) (?<time>\d{2}:\d{2}:\d{2}) (?<year>\d{4})$/i.exec(
      value,
    )?.groups;
  if (!parts) return false;
  const month = months.indexOf(parts.month.toLowerCase());
  const day = Number(parts.day);
  const [hour, minute, second] = parts.time.split(":").map(Number);
  if (month < 0 || hour > 23 || minute > 59 || second > 60) return false;
  if (second === 60 && (hour !== 23 || minute !== 59)) return false;

  const date = new Date(0);
  date.setUTCHours(hour, minute, Math.min(second, 59));
  const year = Number(parts.year);
  const obsoleteYear = parts.year.length === 2;
  if (obsoleteYear) {
    const cutoff = new Date();
    cutoff.setUTCFullYear(cutoff.getUTCFullYear() + 50);
    const candidate = Math.floor(cutoff.getUTCFullYear() / 100) * 100 + year;
    date.setUTCFullYear(candidate, month, day);
    if (date > cutoff) date.setUTCFullYear(candidate - 100, month, day);
  } else {
    date.setUTCFullYear(year, month, day);
  }
  const weekday = weekdays[date.getUTCDay()];
  return (
    date.getUTCMonth() === month &&
    date.getUTCDate() === day &&
    parts.weekday.toLowerCase() === (obsoleteYear ? weekday : weekday.slice(0, 3))
  );
}

function retryAfter(error: unknown) {
  if (!error || typeof error !== "object" || !("headers" in error)) return undefined;
  const headers = error.headers;
  if (!(headers instanceof Headers)) return undefined;
  const value = headers.get("retry-after");
  return value && (/^\d+$/.test(value) || validHttpDate(value)) ? value : undefined;
}

export function createLlm({
  data = process.env,
  fixtureDir = "test/fixtures/llm",
}: { data?: Record<string, unknown>; fixtureDir?: string } = {}) {
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
  ): Promise<{ text: string; usage: components["schemas"]["LlmUsage"] }> => {
    const file = join(fixtureDir, fixtureKey(request) + ".json");
    let result: Completion;
    if (env.LLM_MODE === "mock") {
      result = completion(JSON.parse(await readFile(file, "utf8")));
    } else {
      try {
        result = await generate(env, request);
      } catch (error) {
        if (error instanceof ToolProblem) throw error;
        throw new ToolProblem(503, "provider_unavailable", "LLM request failed", retryAfter(error));
      }
    }
    const { cachedInputTokens = 0, cacheWriteTokens = 0 } = result;
    const {
      inputMicrosPerMillion,
      outputMicrosPerMillion,
      cachedInputMicrosPerMillion = inputMicrosPerMillion,
      cacheWriteMicrosPerMillion = inputMicrosPerMillion,
    } = request.price;
    const uncached = result.inputTokens - cachedInputTokens - cacheWriteTokens;
    const costMicrosUsd = Math.round(
      (uncached * inputMicrosPerMillion +
        cachedInputTokens * cachedInputMicrosPerMillion +
        cacheWriteTokens * cacheWriteMicrosPerMillion +
        result.outputTokens * outputMicrosPerMillion) /
        1_000_000,
    );
    if (!Number.isSafeInteger(costMicrosUsd) || costMicrosUsd < 0)
      throw new Error("Invalid LLM usage cost");
    if (env.LLM_MODE === "record") {
      await mkdir(fixtureDir, { recursive: true });
      const directory = await mkdtemp(join(fixtureDir, ".record-"));
      try {
        const temporary = join(directory, "fixture.json");
        await writeFile(temporary, JSON.stringify(result, null, 2) + "\n");
        await rename(temporary, file);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
    return {
      text: result.text,
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
