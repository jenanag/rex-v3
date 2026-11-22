export const llmEnvProperties = {
  LLM_MODE: {
    type: "string",
    enum: ["live", "mock", "record"],
    description: "Mock by default in tests, live otherwise.",
  },
  OPENAI_API_KEY: { type: "string", description: "OpenAI credential for live or record mode." },
  ANTHROPIC_API_KEY: {
    type: "string",
    description: "Anthropic credential for live or record mode.",
  },
  GEMINI_API_KEY: { type: "string", description: "Gemini credential for live or record mode." },
  PERPLEXITY_API_KEY: {
    type: "string",
    description: "Perplexity credential for live or record mode.",
  },
  XAI_API_KEY: { type: "string", description: "xAI credential for live or record mode." },
} as const;
