// Standard text rates, verified against the provider's published table.
export const pricedModels = [
  {
    provider: "openai" as const,
    model: "gpt-6-luna",
    source: "https://developers.openai.com/api/docs/models/gpt-6-luna#pricing",
    verifiedOn: "2026-11-24",
    price: {
      inputMicrosPerMillion: 100_000,
      cachedInputMicrosPerMillion: 10_000,
      cacheWriteMicrosPerMillion: 125_000,
      outputMicrosPerMillion: 500_000,
    },
  },
] as const;
