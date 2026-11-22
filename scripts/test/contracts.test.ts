import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = resolve(".");
const answer = "packages/contracts/openapi/services/answer-analysis.yaml";
const answerDir = "services/answer-analysis";
const manifest = "packages/contracts/vendoring.yaml";
const common = "packages/contracts/openapi/common.yaml";
const events = "packages/contracts/asyncapi/events.yaml";
const topology = "packages/contracts/bus/topology.yaml";
const policy = "packages/contracts/cache/policy.yaml";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "rex-contract-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const folders = ["docs", "packages", "services", "scripts", ".github", ".cursor"];
  const inputs = [
    ...folders,
    "AGENTS.md",
    "CLAUDE.md",
    "README.md",
    "package.json",
    "redocly.yaml",
  ];
  await Promise.all(
    inputs.map((file) =>
      cp(join(root, file), join(dir, file), {
        recursive: true,
        filter: (file) => !file.includes("/node_modules") && !file.includes("/.venv"),
      }),
    ),
  );
  await symlink(join(root, "node_modules"), join(dir, "node_modules"));
  return {
    dir,
    run: (script: string, ...args: string[]) =>
      exec(
        process.execPath,
        [
          join(root, "node_modules/tsx/dist/cli.mjs"),
          join(dir, "scripts/lib", script + ".ts"),
          ...args,
        ],
        { cwd: dir },
      ),
    async write(file: string, text: string) {
      await mkdir(dirname(join(dir, file)), { recursive: true });
      await writeFile(join(dir, file), text);
    },
    async change(file: string, search: string, replacement: string) {
      const path = join(dir, file);
      const content = await readFile(path, "utf8");
      assert.ok(content.includes(search), "Fixture text not found in " + file + ": " + search);
      await writeFile(path, content.replace(search, replacement));
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const cases: [string, string, (repo: Fixture) => Promise<void>][] = [
  [
    "copied component",
    "copied-components",
    (repo) => repo.change(answer, "  schemas:", "  schemas:\n    LanguageTag: {type: string}"),
  ],
  [
    "inline problem response",
    "copied-components",
    (repo) =>
      repo.change(
        answer,
        "  schemas:",
        "  responses:\n    Inline:\n      description: Inline\n      content: {application/problem+json: {schema: {type: object}}}\n  schemas:",
      ),
  ],
  [
    "unpaginated orchestrator list",
    "copied-components",
    (repo) =>
      repo.change(
        "packages/contracts/openapi/services/orchestrator.yaml",
        "../common.yaml#/components/schemas/Page",
        "../common.yaml#/components/schemas/Url",
      ),
  ],
  [
    "structural schema clone",
    "duplicate-schema",
    (repo) =>
      repo.change(
        answer,
        "  schemas:",
        "  schemas:\n    DuplicateA: {type: object, properties: {a: {type: string}, b: {type: number}, c: {type: boolean}}}\n    DuplicateB: {type: object, title: Clone, properties: {c: {type: boolean}, b: {type: number}, a: {type: string}}}",
      ),
  ],
  [
    "stateful tool status",
    "stateless",
    (repo) => repo.change(answer, "        '200':", "        '202':"),
  ],
  [
    "tool path parameters",
    "stateless",
    (repo) => repo.change(answer, "/v1/analyzers:", "/v1/analyzers/{id}:"),
  ],
  [
    "tool auth",
    "no-auth",
    (repo) => repo.change(answer, "security: []", "security: [{bearerToken: []}]"),
  ],
  [
    "operation-level auth",
    "no-auth",
    (repo) =>
      repo.change(
        answer,
        "      operationId: analyzeAnswer",
        "      operationId: analyzeAnswer\n      security: []",
      ),
  ],
  [
    "tool cache reference",
    "no-cache",
    (repo) =>
      repo.change(
        answer,
        "  schemas:",
        "  schemas:\n    CacheAlias: {$ref: '../common.yaml#/components/schemas/CacheScope'}",
      ),
  ],
  [
    "missing cache operation",
    "cache-policy",
    (repo) => repo.change(policy, "      analyzeAnswer:", "      missingOperation:"),
  ],
  [
    "bad cache pointer",
    "cache-policy",
    (repo) => repo.change(policy, "prompt: collapse-whitespace", "absent: collapse-whitespace"),
  ],
  [
    "bad cache scope",
    "cache-policy",
    (repo) =>
      repo.change(
        policy,
        "      listAnalyzers: {ttl: PT5M, scope: shared}",
        "      listAnalyzers: {ttl: PT5M, scope: invalid}",
      ),
  ],
  [
    "cache defaults outside limits",
    "cache-policy",
    (repo) => repo.change(policy, "maxTtl: P90D", "maxTtl: PT5M"),
  ],
  [
    "republished cache precedence",
    "cache-policy",
    (repo) =>
      repo.change(
        "docs/services/answer-analysis.md",
        "## Caching (by callers)",
        "## Caching (by callers)\n\ncustomer > environment > default",
      ),
  ],
  [
    "inlined language tag",
    "language-tag",
    (repo) =>
      repo.change(answer, "$ref: '../common.yaml#/components/schemas/LanguageTag'", "type: string"),
  ],
  [
    "missing lexicon extension",
    "language-tag",
    async (repo) => {
      const file = "docs/services/answer-analysis.md";
      await repo.change(file, "lexicons/<subtag>/", "packs/");
      await repo.change(file, "lexicons/<subtag>/", "packs/");
    },
  ],
  [
    "unconfigured retry delay",
    "retry",
    (repo) => repo.change(topology, "delays: [10s, 1m, 5m, 30m]", "delays: [2s]"),
  ],
  [
    "concrete retry delay in docs",
    "retry",
    (repo) =>
      repo.change("docs/services/workers.md", "## Behavior", "## Behavior\n\nRetry delays: 10s."),
  ],
  [
    "reused operationId",
    "ownership",
    (repo) => repo.change(answer, "operationId: analyzeAnswer", "operationId: queryEngine"),
  ],
  [
    "unbound bus key",
    "bus",
    (repo) =>
      repo.change(
        topology,
        "routingKey: content-extraction.requested",
        "routingKey: missing.requested",
      ),
  ],
  [
    "invalid bus producer",
    "bus",
    (repo) => repo.change(events, "x-rex-producers: [orchestrator]", "x-rex-producers: [gateway]"),
  ],
  [
    "target outside the contract",
    "vendoring",
    (repo) =>
      repo.change(manifest, "target: contract/openapi.yaml", "target: contract/../../openapi.yaml"),
  ],
  [
    "missing types binding",
    "vendoring",
    (repo) =>
      repo.change(
        manifest,
        "      - {how: types, from: ./contract/openapi.yaml, fromPhase: 1}\n",
        "",
      ),
  ],
  [
    "external reference in bundle",
    "vendoring",
    (repo) =>
      repo.change(
        answerDir + "/contract/openapi.yaml",
        "'#/components/schemas/AnswerAnalysisRequest'",
        "'../other.yaml#/components/schemas/AnswerAnalysisRequest'",
      ),
  ],
  [
    "unsupported tool language",
    "tool-language",
    (repo) => repo.change(manifest, "language: ts", "language: rust"),
  ],
  [
    "language on platform service",
    "tool-language",
    (repo) =>
      repo.change(manifest, "  gateway:\n    files:", "  gateway:\n    language: ts\n    files:"),
  ],
  [
    "npm workspace dependency",
    "portability",
    (repo) => repo.write(answerDir + "/package.json", '{"dependencies":{"fastify":"workspace:*"}}'),
  ],
  [
    "tool internal dependency",
    "portability",
    (repo) => repo.write(answerDir + "/package.json", '{"dependencies":{"@rex/cache":"1.0.0"}}'),
  ],
  [
    "tool imports across service boundary",
    "portability",
    (repo) =>
      repo.write(answerDir + "/src/index.ts", 'import "../../content-auditor/src/index.js";'),
  ],
  [
    "Python path dependency",
    "portability",
    async (repo) => {
      await repo.change(
        manifest,
        "  answer-analysis:\n    language: ts",
        "  answer-analysis:\n    language: python",
      );
      await repo.write(
        answerDir + "/pyproject.toml",
        '[project]\ndependencies = ["fastapi>=1"]\n[tool.uv.sources]\nfastapi = {path = "../../fixture"}\n',
      );
      await repo.write(answerDir + "/uv.lock", "");
    },
  ],
  [
    "Go replace directive",
    "portability",
    async (repo) => {
      await repo.change(
        manifest,
        "  answer-analysis:\n    language: ts",
        "  answer-analysis:\n    language: go",
      );
      await repo.write(
        answerDir + "/go.mod",
        "module fixture\nreplace example.com/test => ../outside\n",
      );
      await repo.write(answerDir + "/go.sum", "");
    },
  ],
  [
    "unapproved runtime dependency",
    "approved-dependencies",
    (repo) => repo.write(answerDir + "/package.json", '{"dependencies":{"axios":"1.0.0"}}'),
  ],
  [
    "unlisted internal package",
    "internal-packages",
    (repo) => repo.write("packages/duplicate/package.json", "{}"),
  ],
  [
    "broken agent instructions link",
    "agent-instructions",
    (repo) => repo.change("AGENTS.md", "[README](README.md)", "[README](MISSING.md)"),
  ],
  [
    "planned command already exists",
    "agent-instructions",
    (repo) =>
      repo.change(
        "AGENTS.md",
        "### Inside a tool folder",
        "### Arrives (planned)\n\n`\`\`bash\nscripts/new-tool\n`\`\`\n\n### Inside a tool folder",
      ),
  ],
  [
    "tool outbound fetch",
    "limits",
    (repo) => repo.change(answer, "outboundFetch: none", "outboundFetch: one"),
  ],
  [
    "public operation LLM use",
    "limits",
    (repo) =>
      repo.change(
        "packages/contracts/openapi/services/content-auditor.yaml",
        "p99: PT2S, llm: none",
        "p99: PT2S, llm: required",
      ),
  ],
  [
    "external caller",
    "external-callers",
    (repo) => repo.change(policy, "callers: [workers]", "callers: [gateway]"),
  ],
  [
    "missing external hand-off",
    "external-callers",
    (repo) =>
      repo.change(
        manifest,
        "target: handoff/content-extractor.openapi.yaml, from: openapi/services/content-extractor.yaml, how: bundle",
        "target: handoff/content-extractor.openapi.yaml, from: openapi/services/content-extractor.yaml, how: copy",
      ),
  ],
];

test("cross-file rule fixtures", { concurrency: 4 }, async (t) => {
  const clean = await fixture(t);
  await clean.run("check-contracts", "--source-only");
  await Promise.all(
    cases.map(([name, rule, mutate]) =>
      t.test(name, async (subtest) => {
        const repo = await fixture(subtest);
        await mutate(repo);
        await assert.rejects(
          repo.run("check-contracts", "--source-only"),
          (error: unknown) =>
            error instanceof Error &&
            "stderr" in error &&
            String(error.stderr).includes("[" + rule + "]"),
        );
      }),
    ),
  );
});

test("vendoring detects source, shared schema and generated drift", async (t) => {
  const repo = await fixture(t);
  await repo.run("vendor-contracts", "--phase", "0", "--check");
  await repo.run("vendor-contracts", "--service", "answer-analysis", "--check");
  await repo.change(answer, "Detect brand mentions", "Locate brand mentions");
  const check = () => repo.run("vendor-contracts", "--service", "answer-analysis", "--check");
  await assert.rejects(check, /services\/answer-analysis\/contract\/openapi.yaml/);
  await repo.run("vendor-contracts", "--service", "answer-analysis");
  await repo.change(common, "BCP 47 language tag", "BCP 47 language identifier");
  await assert.rejects(check, /services\/answer-analysis\/contract\/types.ts/);
  await repo.run("vendor-contracts", "--service", "answer-analysis");
  await repo.change(answerDir + "/contract/types.ts", "GENERATED", "ALTERED");
  await assert.rejects(check, /services\/answer-analysis\/contract\/types.ts/);
});

test("Python vendoring preflights before writing any file", async (t) => {
  const repo = await fixture(t);
  await repo.change(
    manifest,
    "  answer-analysis:\n    language: ts",
    "  answer-analysis:\n    language: python",
  );
  await rm(join(repo.dir, "services/engine-query/contract/types.ts"));
  await assert.rejects(
    repo.run("vendor-contracts"),
    /generator not set up yet: run the python bring-up/,
  );
  await assert.rejects(readFile(join(repo.dir, "services/engine-query/contract/types.ts")), {
    code: "ENOENT",
  });
});

test("docs generation detects drift and refreshes from source", async (t) => {
  const repo = await fixture(t);
  await repo.run("gen-docs", "--check");
  await repo.change(answer, "Detect brand mentions", "Locate brand mentions");
  await repo.change(
    "docs/roadmap.md",
    "recorded fixtures for every engine.",
    "recorded fixtures for every engine,\n   including recorded source metadata.",
  );
  await assert.rejects(repo.run("gen-docs", "--check"), /services\/answer-analysis\/AGENTS.md/);
  await repo.run("gen-docs");
  await repo.run("gen-docs", "--check");

  const readDoc = async (path: string) =>
    (await readFile(join(repo.dir, path), "utf8")).replace(/\s+/g, " ");
  const engine = await readDoc("services/engine-query/AGENTS.md");
  const citations = await readDoc("services/citation-extractor/AGENTS.md");
  const llms = await readDoc("docs/services/llms-txt-generator.md");
  assert.doesNotMatch(engine, /prompt-tracker/);
  assert.doesNotMatch(citations, /citation-tracker/);
  assert.match(engine, /Not scaffolded yet.*`scripts\/new-tool` \(built in Phase 1\)/);
  assert.match(engine, /as Jay decided in ADR 0024.*the fan-out across engines stays in workers/);
  assert.match(engine, /`listEngines`: internal \(workers only\); no max duration stated yet/);
  assert.match(engine, /recorded fixtures for every engine, including recorded source metadata/);
  assert.match(llms, /public via gateway at `\/v1\/tools\/llms-txt\/validate`/);
  assert.match(llms, /scope and freshness can be overridden per environment and per customer/);
  assert.match(llms, /`describePage` \| `P30D` \| shared \| read back by reference/);
  assert.doesNotMatch(llms, /archive to data-aggregator/);
});

test("each tool's OpenAPI bundle validates in an empty directory", async (t) => {
  const standalone = await mkdtemp(join(tmpdir(), "rex-openapi-standalone-"));
  t.after(() => rm(standalone, { recursive: true, force: true }));
  const tools = [
    "answer-analysis",
    "citation-extractor",
    "content-auditor",
    "engine-query",
    "llms-txt-generator",
    "schema-generator",
  ];
  await Promise.all(
    tools.map(async (tool) => {
      const copied = join(standalone, tool);
      await mkdir(copied, { recursive: true });
      await cp(join(root, "services", tool, "contract/openapi.yaml"), join(copied, "openapi.yaml"));
      await exec(
        join(root, "node_modules/.bin/redocly"),
        ["lint", "--extends", "spec", "openapi.yaml"],
        {
          cwd: copied,
        },
      );
    }),
  );
});
