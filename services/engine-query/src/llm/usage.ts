import type { Response } from "openai/resources/responses/responses";
import type { components } from "../../contract/types.js";
import type { OpenAiModel } from "./catalog.js";

export function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("Invalid or missing provider usage");
  return value;
}

export function answerUsage(
  response: Response,
  { provider, model, price }: OpenAiModel,
  webSearch: boolean,
): components["schemas"]["LlmUsage"] {
  if (response.service_tier != null && response.service_tier !== "default")
    throw new Error("Unexpected provider service tier");

  const usage = response.usage;
  const inputTokens = count(usage?.input_tokens);
  const outputTokens = count(usage?.output_tokens);
  const reads = count(usage?.input_tokens_details?.cached_tokens);
  const writes = count(usage?.input_tokens_details?.cache_write_tokens);
  const reportedSearches = response.tool_usage?.web_search?.num_requests;
  const searches = count(!webSearch && reportedSearches === undefined ? 0 : reportedSearches);
  if (!webSearch && searches !== 0)
    throw new Error("Provider reported billable web search in text-only mode");
  const writeDetails = usage?.input_tokens_details?.cache_write_tokens_details;
  const reasoning = usage?.output_tokens_details?.reasoning_tokens;
  if (
    count(usage?.total_tokens) !== inputTokens + outputTokens ||
    reads + writes > inputTokens ||
    (reasoning !== undefined && count(reasoning) > outputTokens) ||
    (writeDetails !== undefined &&
      (count(writeDetails.ttl_12h_tokens) !== 0 || count(writeDetails.ttl_30m_tokens) !== writes))
  )
    throw new Error("Inconsistent provider usage");

  const costMicrosUsd = Math.round(
    (inputTokens - reads - writes) * price.input +
      reads * price.read +
      writes * price.write +
      outputTokens * price.output +
      searches * price.searchMicros,
  );
  return {
    provider,
    model,
    operation: "answer_prompt",
    inputTokens,
    outputTokens,
    costMicrosUsd: count(costMicrosUsd),
  };
}
