import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { envSchema } from "env-schema";
import OpenAI from "openai";
import type {
  Response,
  ResponseCreateParamsNonStreaming,
} from "openai/resources/responses/responses";
import type { TextPart } from "../domain/citations.js";
import { ToolProblem } from "../errors.js";
import type { Engine } from "./catalog.js";
import { llmEnvProperties } from "./env.js";
import { retryAfter } from "./retry-after.js";
import { answerUsage } from "./usage.js";

type LlmEnv = {
  LLM_MODE: "live" | "mock" | "record";
  OPENAI_API_KEY?: string;
};

export const providerTimeoutMs = 110_000;
const endpoint = "https://api.openai.com/v1";

function responsesRequest(model: string, prompt: string, locale: string, country: string) {
  return {
    model,
    instructions:
      "Use the web search tool to answer the user's prompt in Markdown. Prefer answer locale " +
      locale +
      ".",
    input: [{ role: "user", content: prompt }],
    tools: [
      {
        type: "web_search",
        search_context_size: "low",
        user_location: { type: "approximate", country },
      },
    ],
    tool_choice: "required",
    max_tool_calls: 1,
    reasoning: { effort: "low" },
    max_output_tokens: 2_048,
    store: false,
    service_tier: "default",
    prompt_cache_options: { ttl: "30m" },
  } satisfies ResponseCreateParamsNonStreaming;
}

export function fixtureKey(model: string, prompt: string, locale: string, country: string) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        endpoint: endpoint + "/responses",
        request: responsesRequest(model, prompt, locale, country),
      }),
    )
    .digest("hex");
}

function answerParts(result: Response, model: string): TextPart[] {
  if (result.model !== model) throw new Error("Unexpected provider model");
  if (result.status !== "completed" || result.error || result.incomplete_details)
    throw new Error("Provider response did not complete");
  if (
    !result.output.some(
      (item) =>
        item.type === "web_search_call" &&
        item.status === "completed" &&
        item.action?.type === "search",
    )
  )
    throw new Error("Required web search did not complete");

  const parts = result.output.flatMap((item) => {
    if (item.type !== "message" || item.role !== "assistant") return [];
    if (item.status !== "completed" || item.content.some((part) => part.type === "refusal"))
      throw new Error("Provider answer was refused or incomplete");
    return item.content.filter((part) => part.type === "output_text");
  });
  if (parts.some((part) => typeof part.text !== "string" || !Array.isArray(part.annotations)))
    throw new Error("Invalid provider text part");
  if (!parts.some((part) => part.text.trim())) throw new Error("Provider answer was blank");
  return parts.map(({ text, annotations }) => ({
    text,
    annotations: annotations.filter((item) => item?.type === "url_citation"),
  }));
}

async function record(fixtureDir: string, file: string, result: Response) {
  const { model, status, error, incomplete_details, output, usage, tool_usage, service_tier } =
    result;
  const fixture = {
    model,
    status,
    error,
    incomplete_details,
    output,
    usage,
    tool_usage,
    service_tier,
  };
  await mkdir(fixtureDir, { recursive: true });
  const directory = await mkdtemp(join(fixtureDir, ".record-"));
  try {
    const temporary = join(directory, "fixture.json");
    await writeFile(temporary, JSON.stringify(fixture, null, 2) + "\n");
    await rename(temporary, file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function createLlm({
  data = process.env,
  fixtureDir = "test/fixtures/llm",
  fetch,
}: {
  data?: Record<string, unknown>;
  fixtureDir?: string;
  fetch?: typeof globalThis.fetch;
} = {}) {
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

  return async (entry: Engine, prompt: string, locale: string, country: string) => {
    const { model } = entry.engine;
    const file = join(fixtureDir, fixtureKey(model, prompt, locale, country) + ".json");
    try {
      let result: Response;
      if (env.LLM_MODE === "mock") {
        result = JSON.parse(await readFile(file, "utf8")) as Response;
      } else {
        if (!env.OPENAI_API_KEY) throw new Error("Missing provider credential");
        const client = new OpenAI({
          apiKey: env.OPENAI_API_KEY,
          baseURL: endpoint,
          maxRetries: 0,
          fetch,
        });
        result = await client.responses.create(responsesRequest(model, prompt, locale, country), {
          signal: AbortSignal.timeout(providerTimeoutMs),
          timeout: providerTimeoutMs,
        });
      }

      const usage = answerUsage(result, entry);
      const parts = answerParts(result, model);
      if (env.LLM_MODE === "record") await record(fixtureDir, file, result);
      return { parts, usage };
    } catch (error) {
      throw new ToolProblem(
        503,
        "provider_unavailable",
        "Engine provider could not supply a usable answer",
        retryAfter(error),
      );
    }
  };
}
