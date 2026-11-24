import type { Response } from "openai/resources/responses/responses";
import type { components } from "../../contract/types.js";
import type { Engine } from "./catalog.js";

export type EngineResponse = Response & {
  usage?: {
    server_side_tool_usage_details?: { web_search_calls?: unknown };
    cost_in_usd_ticks?: unknown;
  };
};

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("Invalid or missing provider usage");
  return value;
}

export function answerUsage(
  response: EngineResponse,
  { engine, price }: Engine,
  warn?: (message: string) => void,
): components["schemas"]["LlmUsage"] {
  if (response.service_tier != null && response.service_tier !== "default")
    throw new Error("Unexpected provider service tier");

  const usage = response.usage;
  const inputTokens = count(usage?.input_tokens);
  const outputTokens = count(usage?.output_tokens);
  const reads = count(usage?.input_tokens_details?.cached_tokens);
  const reasoning = usage?.output_tokens_details?.reasoning_tokens;
  if (
    count(usage?.total_tokens) - inputTokens !== outputTokens ||
    reads > inputTokens ||
    (reasoning !== undefined && count(reasoning) > outputTokens)
  )
    throw new Error("Inconsistent provider usage");

  let costMicrosUsd: number;
  if ("longContextAt" in price) {
    const webCalls = count(usage?.server_side_tool_usage_details?.web_search_calls);
    const rates = inputTokens >= price.longContextAt ? price.longContext : price.shortContext;
    const ticks =
      BigInt(inputTokens - reads) * rates.input +
      BigInt(reads) * rates.read +
      BigInt(outputTokens) * rates.output +
      BigInt(webCalls) * price.webCallTicks;
    const reported = usage?.cost_in_usd_ticks;
    // No verified pricing adjustment applies to the configured Standard global request.
    if (reported === undefined) warn?.("xAI usage omitted cost ticks; using catalog pricing");
    else if (BigInt(count(reported)) !== ticks)
      throw new Error("xAI cost does not reconcile with catalog pricing");
    // 10,000 ticks per microdollar. Round once, including the tool fees.
    costMicrosUsd = Number((ticks + 5_000n) / 10_000n);
  } else {
    const writes = count(usage?.input_tokens_details?.cache_write_tokens);
    const searches = count(response.tool_usage?.web_search?.num_requests);
    const writeDetails = usage?.input_tokens_details?.cache_write_tokens_details;
    if (
      writes > inputTokens - reads ||
      (writeDetails !== undefined &&
        (count(writeDetails.ttl_12h_tokens) !== 0 || count(writeDetails.ttl_30m_tokens) !== writes))
    )
      throw new Error("Inconsistent provider usage");
    costMicrosUsd = Math.round(
      (inputTokens - reads - writes) * price.input +
        reads * price.read +
        writes * price.write +
        outputTokens * price.output +
        searches * price.searchMicros,
    );
  }
  return {
    provider: engine.provider,
    model: engine.model,
    operation: "answer_prompt",
    inputTokens,
    outputTokens,
    costMicrosUsd: count(costMicrosUsd),
  };
}
