import { expect, test } from "vitest";
import { createLlm, type LlmRequest } from "../src/llm/adapter.js";

test("mock mode maps a deterministic fixture to contract usage without credentials", async () => {
  const request: LlmRequest = {
    provider: "openai",
    model: "fixture-model",
    operation: "echo_test",
    prompt: "Hello",
    maxOutputTokens: 32,
    timeoutMs: 100,
    price: { inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 2_000_000 },
  };
  const llm = createLlm({ data: { NODE_ENV: "test" } });
  await expect(llm(request)).resolves.toEqual({
    text: "Hello from a fixture",
    usage: {
      provider: "openai",
      model: "fixture-model",
      operation: "echo_test",
      inputTokens: 4,
      outputTokens: 5,
      costMicrosUsd: 14,
    },
  });
  await expect(llm({ ...request, prompt: "missing fixture" })).rejects.toThrow("ENOENT");
});
