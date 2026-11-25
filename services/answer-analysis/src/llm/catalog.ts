export const modelCatalog = [
  {
    provider: "openai",
    model: "gpt-6-luna",
    // OpenAI Standard, short context. See the answer-analysis service doc.
    price: {
      inputMicrosPerMillion: 100_000,
      cachedInputMicrosPerMillion: 10_000,
      cacheWriteMicrosPerMillion: 125_000,
      outputMicrosPerMillion: 500_000,
    },
    languages: ["*"],
    description: "Classifies sentiment for mentioned brands with OpenAI GPT-6 Luna.",
  },
] as const;
