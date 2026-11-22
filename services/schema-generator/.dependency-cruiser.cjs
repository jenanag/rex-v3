module.exports = {
  forbidden: [
    {
      name: "stay-inside-tool",
      severity: "error",
      from: {},
      to: { path: "^(?:\\.\\./|/)|^@rex/" },
    },
    {
      name: "resolve-imports",
      severity: "error",
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: "provider-sdks-in-adapter",
      severity: "error",
      from: { pathNot: "^src/llm/" },
      to: { path: "(?:^|/)node_modules/(?:openai|@anthropic-ai/sdk|@google/genai)(?:/|$)" },
    },
  ],
  options: {
    doNotFollow: { path: "(^|/)node_modules/" },
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "node", "default"],
    },
  },
};
