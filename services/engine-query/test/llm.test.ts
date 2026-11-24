import { expect, test } from "vitest";
import { createLlm, fixtureKey } from "../src/llm/adapter.js";
import { deployment } from "../src/llm/catalog.js";

const entry = deployment[0].models[0];
const { model } = entry;
const prompt = "What is the Discovery Pass?";

test("mock mode replays synthetic Responses output without credentials or transport", async () => {
  const llm = createLlm({
    data: { LLM_MODE: "mock" },
    fetch: async () => {
      throw new Error("Unexpected provider traffic");
    },
  });
  const result = await llm(entry, prompt, "en-US", "US", true);
  expect(result.parts[0].text).toBe("The pass covers admission to participating sites.");
  expect(result.usage).toEqual({
    provider: "openai",
    model,
    operation: "answer_prompt",
    inputTokens: 2_000,
    outputTokens: 200,
    costMicrosUsd: 10_211,
  });
  await expect(llm(entry, "missing fixture", "en-US", "US", true)).rejects.toMatchObject({
    statusCode: 503,
    problemCode: "provider_unavailable",
  });
});

test("fixture keys distinguish prompt whitespace, locale and search country", () => {
  const key = fixtureKey(model, prompt, "en-US", "US");
  expect(fixtureKey(model, prompt, "en-US", "US", true)).toBe(key);
  expect(fixtureKey(model, prompt, "en-US", "US", false)).not.toBe(key);
  expect(fixtureKey(model, prompt.replace("the ", "the  "), "en-US", "US")).not.toBe(key);
  expect(fixtureKey(model, prompt, "fr-CA", "US")).not.toBe(key);
  expect(fixtureKey(model, prompt, "en-US", "CA")).not.toBe(key);
});
