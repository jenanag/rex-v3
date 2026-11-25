import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { parse, stringify } from "yaml";

const exec = promisify(execFile);
const root = resolve(".");
const gitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
  encoding: "utf8",
}).trim();
const answer = "packages/contracts/openapi/services/answer-analysis.yaml";
const answerDir = "services/answer-analysis";
const manifest = "packages/contracts/vendoring.yaml";
const common = "packages/contracts/openapi/common.yaml";
const events = "packages/contracts/asyncapi/events.yaml";
const topology = "packages/contracts/bus/topology.yaml";
const policy = "packages/contracts/cache/policy.yaml";

async function fixture(t: { after: (fn: () => Promise<void>) => void }, ownBaseline = false) {
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
        { cwd: dir, env: { ...process.env, GIT_DIR: ownBaseline ? join(dir, ".git") : gitDir } },
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
const cases: [string, string, (repo: Fixture) => Promise<void>, string?][] = [
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
    (repo) =>
      repo.change(
        policy,
        "        window: P1D",
        "        normalize: {absent: collapse-whitespace}\n        window: P1D",
      ),
  ],
  [
    "missing analyzer order exception",
    "cache-policy",
    (repo) => repo.change(policy, "        preserveArrayOrder: [/sentiment/analyzers]\n", ""),
    "including /sentiment/analyzers",
  ],
  [
    "order preservation targets an array that is already ordered",
    "cache-policy",
    (repo) =>
      repo.change(
        policy,
        "preserveArrayOrder: [/sentiment/analyzers]",
        "preserveArrayOrder: [/sentiment/analyzers, /brands]",
      ),
    "must target a request array with uniqueItems: true at /brands",
  ],
  [
    "missing raw URL mapping",
    "cache-policy",
    (repo) => repo.change(policy, "          robotsTxtUrl: /robotsTxt/url\n", ""),
  ],
  [
    "missing original page URL mapping",
    "cache-policy",
    (repo) => repo.change(policy, "        rawUrlKeyInputs: {url: /url}\n", ""),
    "describePage: rawUrlKeyInputs must be a nonempty mapping",
  ],
  [
    "page URL mapping targets an optional metadata URL",
    "cache-policy",
    (repo) => repo.change(policy, "{url: /url}", "{url: /metadata/canonicalUrl}"),
    "must target a required shared Url at /metadata/canonicalUrl",
  ],
  [
    "swapped raw URL mappings",
    "cache-policy",
    (repo) =>
      repo.change(
        policy,
        "          siteUrl: /siteUrl\n          robotsTxtUrl: /robotsTxt/url",
        "          siteUrl: /robotsTxt/url\n          robotsTxtUrl: /siteUrl",
      ),
  ],
  [
    "raw URL mapped to a non-URL property",
    "cache-policy",
    (repo) =>
      repo.change(policy, "robotsTxtUrl: /robotsTxt/url", "robotsTxtUrl: /robotsTxt/status"),
    "must target a required shared Url at /robotsTxt/status",
  ],
  [
    "malformed raw URL pointer",
    "cache-policy",
    (repo) => repo.change(policy, "robotsTxtUrl: /robotsTxt/url", "robotsTxtUrl: /robotsTxt/~2url"),
    "must target a required shared Url at /robotsTxt/~2url",
  ],
  [
    "conflicting raw URL alias",
    "cache-policy",
    (repo) =>
      repo.change(
        policy,
        "        rawUrlKeyInputs:",
        "        extraKeyInputs: [siteUrl]\n        rawUrlKeyInputs:",
      ),
    "has an invalid or conflicting alias siteUrl",
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
    cases.map(([name, rule, mutate, detail]) =>
      t.test(name, async (subtest) => {
        const repo = await fixture(subtest);
        await mutate(repo);
        await assert.rejects(
          repo.run("check-contracts", "--source-only"),
          (error: unknown) =>
            error instanceof Error &&
            "stderr" in error &&
            String(error.stderr).includes("[" + rule + "]") &&
            (!detail || String(error.stderr).includes(detail)),
        );
      }),
    ),
  );
});

test("breaking request changes require an info.version major bump", async (t) => {
  const repo = await fixture(t, true);
  const file = "packages/contracts/openapi/services/schema-generator.yaml";
  const spec = parse(await readFile(join(repo.dir, file), "utf8"));
  const schemas = spec.components.schemas;
  const data = schemas.FromData.properties.data;
  data.properties = {
    items: { type: "array", maxItems: 4, items: { type: "string", enum: ["a", "b"] } },
    title: { type: "string", minLength: 1 },
    score: { type: "number", minimum: 0, maximum: 10 },
    label: { type: ["string", "null"] },
    optional: { type: "boolean" },
  };
  const save = () => repo.write(file, stringify(spec));
  const check = () => repo.run("check-contracts", "--source-only");
  const git = (...args: string[]) => exec("git", args, { cwd: repo.dir });
  await save();
  await git("init", "-b", "main");
  await git("add", "packages/contracts/openapi");
  await git(
    "-c",
    "user.name=REx tests",
    "-c",
    "user.email=tests@rex.invalid",
    "-c",
    "commit.gpgSign=false",
    "commit",
    "-qm",
    "Request contract baseline",
  );
  await git("update-ref", "refs/remotes/origin/main", "HEAD");

  data.properties.items.items.enum.push("c");
  data.properties.additive = { type: "boolean" };
  schemas.SchemaMarkup.properties.scriptTag.maxLength = 128;
  await save();
  await check();

  schemas.FromHtml.properties.html.maxLength -= 1;
  data.properties.items.maxItems = 3;
  data.properties.items.items.enum = ["a"];
  data.properties.title.minLength = 2;
  data.properties.score.minimum = 1;
  data.properties.score.maximum = 9;
  data.properties.label.type = "string";
  delete data.properties.optional;
  data.required = ["title"];
  await save();
  await assert.rejects(check(), (error: unknown) => {
    assert.ok(error instanceof Error && "stderr" in error);
    const message = String(error.stderr);
    assert.match(message, /\[request-version\].*schema-generator\.yaml/);
    for (const reason of [
      "maxLength lowered",
      "maxItems lowered",
      "maximum lowered",
      "minLength raised",
      "minimum raised",
      "now requires property title",
      "optional: property removed",
      "enum value removed",
      "label: type narrowed",
    ]) {
      assert.ok(message.includes(reason), "Missing diagnostic for " + reason);
    }
    return true;
  });

  spec.info.version = String(Number(spec.info.version.split(".")[0]) + 1) + ".0.0";
  await save();
  await check();
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
  const engineDir = "services/engine-query";
  assert.match(await readFile(join(repo.dir, engineDir, "AGENTS.md"), "utf8"), /Scaffolded:/);
  await rm(join(repo.dir, engineDir, "package.json"));
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
  const analysis = await readDoc(answerDir + "/AGENTS.md");
  const engine = await readDoc("services/engine-query/AGENTS.md");
  const citations = await readDoc("services/citation-extractor/AGENTS.md");
  const llms = await readDoc("docs/services/llms-txt-generator.md");
  assert.match(analysis, /## Language TypeScript .*accepted by Jay in ADR 0035\./);
  assert.match(analysis, /## Scope and build order .*TypeScript, ADR 0035 accepted by Jay/);
  assert.doesNotMatch(analysis, /ADR 0024 proposes Python/);
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

test("crawler cache policy preserves the trailing-dot origin distinction", async () => {
  const { tools } = parse(await readFile(join(root, policy), "utf8"));
  const mapping = tools["content-auditor"].operations.checkCrawlerAccess.rawUrlKeyInputs;
  const requests = ["https://example.test/", "https://example.test./"].map((siteUrl) => ({
    siteUrl,
    robotsTxt: { url: "https://example.test/robots.txt", status: 404, content: null },
  }));
  assert.equal(new URL(requests[0].siteUrl).origin, new URL(requests[0].robotsTxt.url).origin);
  assert.notEqual(new URL(requests[1].siteUrl).origin, new URL(requests[1].robotsTxt.url).origin);
  // Model just the policy steps needed for this collision. Runtime cache derivation
  // is owned by the future caller and is outside this fixture.
  function normalized(request: (typeof requests)[number]) {
    return { ...request, siteUrl: request.siteUrl.replace(/\.\/$/, "/") };
  }
  function withRawInputs(request: (typeof requests)[number]) {
    return {
      ...normalized(request),
      ...Object.fromEntries(
        Object.entries(mapping).map(([alias, pointer]) => [
          "$" + alias,
          (pointer as string)
            .slice(1)
            .split("/")
            .reduce<unknown>((value, key) => (value as Record<string, unknown>)[key], request),
        ]),
      ),
    };
  }
  assert.deepEqual(normalized(requests[0]), normalized(requests[1]));
  assert.deepEqual(withRawInputs(requests[1]), {
    ...normalized(requests[1]),
    $siteUrl: requests[1].siteUrl,
    $robotsTxtUrl: requests[1].robotsTxt.url,
  });
  assert.notDeepEqual(withRawInputs(requests[0]), withRawInputs(requests[1]));
});

test("answer analysis cache input preserves analyzer order and applies HTTP defaults", async () => {
  const { tools, key } = parse(await readFile(join(root, policy), "utf8"));
  const { components } = parse(await readFile(join(root, answer), "utf8"));
  const { AnswerAnalysisRequest, AnswerAnalysisOptions, SentimentOptions } = components.schemas;
  const preserve = tools["answer-analysis"].operations.analyzeAnswer.preserveArrayOrder;
  assert.equal(tools["answer-analysis"].keyVersion, 5);
  assert.deepEqual(tools["answer-analysis"].operations.analyzeAnswer.skipWhen, {
    pointer: "/analyzers/*/status",
    equals: "failed",
  });
  assert.deepEqual(preserve, ["/sentiment/analyzers"]);
  assert.ok(
    key.canonicalInput.some(
      (step: unknown) =>
        typeof step === "string" &&
        step.includes("uniqueItems: true") &&
        step.includes("preserveArrayOrder"),
    ),
  );
  assert.ok(SentimentOptions.properties.analyzers.uniqueItems);
  assert.equal(
    AnswerAnalysisOptions.properties.sentiment.$ref,
    "#/components/schemas/SentimentOptions",
  );
  assert.deepEqual(AnswerAnalysisRequest.properties.sentiment.default, {});
  assert.equal(
    AnswerAnalysisRequest.allOf[0].properties.brands.$ref,
    "#/components/schemas/AnswerAnalysisOptions/properties/brands",
  );
  assert.equal(
    AnswerAnalysisRequest.properties.sentiment.allOf[0].$ref,
    AnswerAnalysisOptions.properties.sentiment.$ref,
  );
  assert.equal(AnswerAnalysisOptions.properties.sentiment.default, undefined);

  // Exercise the policy steps that distinguish these inputs. The runtime
  // cache itself belongs to callers and is not implemented by this fixture.
  type Selector = string | { provider: string; model: string };
  function cacheInput(sentiment?: { analyzers?: Selector[]; onUnsupportedLanguage?: string }) {
    const effective = { ...AnswerAnalysisRequest.properties.sentiment.default, ...sentiment };
    for (const [name, schema] of Object.entries<{ default?: unknown }>(
      SentimentOptions.properties,
    )) {
      if (schema.default !== undefined && !Object.hasOwn(effective, name))
        effective[name] = schema.default;
    }
    return {
      text: "Acme is a top pick, but Acme is bad.",
      brands: [{ key: "acme", kind: "primary", name: "Acme", aliases: [], domains: [] }],
      sentiment: Object.fromEntries(
        Object.keys(effective)
          .sort()
          .map((name) => [
            name,
            SentimentOptions.properties[name].uniqueItems &&
            !preserve.includes("/sentiment/" + name)
              ? [...effective[name]].sort()
              : effective[name],
          ]),
      ),
    };
  }

  const luna = { provider: "openai", model: "gpt-6-luna" };
  const ordered = ["det:lexicon", luna];
  const reversed = ordered.toReversed();
  assert.deepEqual(cacheInput({ analyzers: ordered }).sentiment.analyzers, ordered);
  assert.deepEqual(cacheInput({ analyzers: reversed }).sentiment.analyzers, reversed);
  assert.notDeepEqual(cacheInput({ analyzers: ordered }), cacheInput({ analyzers: reversed }));
  assert.deepEqual(cacheInput(), cacheInput({}));
  assert.deepEqual(
    cacheInput(),
    cacheInput({ analyzers: ["det:lexicon"], onUnsupportedLanguage: "fallback" }),
  );
  assert.notDeepEqual(cacheInput(), cacheInput({ analyzers: [] }));
  const keyFor = (input: unknown) =>
    "rex:c:answer-analysis:analyzeanswer:v3.5:shared:-:0:" + canonicalHash(input);
  assert.equal(keyFor(cacheInput()), keyFor(cacheInput({})));
  assert.equal(
    keyFor(cacheInput({ analyzers: ordered })),
    keyFor(
      cacheInput({ analyzers: ["det:lexicon", { model: luna.model, provider: luna.provider }] }),
    ),
  );
  assert.notEqual(
    keyFor(cacheInput({ analyzers: ordered })),
    keyFor(cacheInput({ analyzers: reversed })),
  );

  assert.equal(
    keyFor(cacheInput()),
    "rex:c:answer-analysis:analyzeanswer:v3.5:shared:-:0:e709689548ff05e5ed3bd1e4a1122022e8ea6a5d6af07adf52ea9c5391406b5a",
  );
  assert.equal(
    keyFor(cacheInput({ analyzers: ordered })),
    "rex:c:answer-analysis:analyzeanswer:v3.5:shared:-:0:024482406262eae9ee6f712fd99794db43fe0bc9e4202a3a1f6479d48666c70c",
  );
  assert.equal(
    keyFor(cacheInput({ analyzers: reversed })),
    "rex:c:answer-analysis:analyzeanswer:v3.5:shared:-:0:8a527de041b4866e21df3e475e2d3affbe135bb1675344e19ae06868c71630c5",
  );
  const warm = new Map([
    [keyFor(cacheInput({ analyzers: ordered })), { analyzers: [{ status: "ok" }] }],
  ]);
  let lookups = 0;
  // The catalog here represents discovery obtained for this deployment. A null
  // catalog means discovery is stale or unavailable.
  function callerLookup(current: Selector[] | null) {
    if (!current) return undefined;
    if (
      ordered.some(
        (item) => !current.some((allowed) => canonicalJson(allowed) === canonicalJson(item)),
      )
    )
      return { status: 422, code: "unsupported_analyzer" };
    lookups++;
    return warm.get(keyFor(cacheInput({ analyzers: ordered })));
  }
  const gate = key.canonicalInput.find((step: string) => step.includes("For analyzeAnswer"));
  assert.match(gate, /before looking up the result/);
  assert.match(gate, /Stale or unavailable discovery cannot authorize a hit/);
  assert.match(gate, /HTTP 422 unsupported_analyzer/);
  assert.deepEqual(callerLookup(ordered), { analyzers: [{ status: "ok" }] });
  assert.deepEqual(callerLookup(["det:lexicon"]), { status: 422, code: "unsupported_analyzer" });
  assert.equal(callerLookup(null), undefined);
  assert.equal(lookups, 1);
});

// The vectors below use only JSON objects, strings, booleans, and arrays.
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value !== null && typeof value === "object") {
    const fields = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return (
      "{" +
      fields.map(([name, item]) => JSON.stringify(name) + ":" + canonicalJson(item)).join(",") +
      "}"
    );
  }
  return JSON.stringify(value);
}

function canonicalHash(value: unknown) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

test("engine query cache vectors key the explicit pair and search mode once", async () => {
  const { tools } = parse(await readFile(join(root, policy), "utf8"));
  const { info, components } = parse(
    await readFile(join(root, "packages/contracts/openapi/services/engine-query.yaml"), "utf8"),
  );
  const { properties, required, allOf } = components.schemas.EngineQuery;
  const { locale, country, webSearch } = properties;
  const { keyVersion, operations } = tools["engine-query"];
  assert.equal(keyVersion, 5);
  assert.equal(info.version, "3.0.0");
  assert.equal(webSearch.type, "boolean");
  assert.equal(webSearch.default, undefined);
  assert.deepEqual(required, ["webSearch", "prompt"]);
  assert.equal(allOf[0].$ref, "../common.yaml#/components/schemas/ProviderModel");
  const { components: shared } = parse(await readFile(join(root, common), "utf8"));
  assert.deepEqual(shared.schemas.ProviderModel.required, ["provider", "model"]);
  for (const field of ["provider", "model"]) {
    assert.deepEqual(shared.schemas.ProviderModel.properties[field], {
      type: "string",
      minLength: 1,
    });
  }
  assert.equal(operations.queryEngine.extraKeyInputs, undefined);
  assert.equal(operations.queryEngine.webSearchDefaults, undefined);
  assert.equal(operations.queryEngine.normalize?.prompt, undefined);

  const luna = { provider: "openai", model: "gpt-6-luna", webSearch: true };
  const gemini = { provider: "google", model: "gemini-3.5-flash-lite", webSearch: false };
  const catalog = [luna, gemini, { ...luna, model: "test-only-alt" }];
  const prompt = "Print 'A  B' verbatim.";
  function vector(selection: typeof luna, hints: { locale?: string; country?: string } = {}) {
    const allowed = catalog.find(
      ({ provider, model }) => provider === selection.provider && model === selection.model,
    );
    assert.ok(allowed, "unsupported pair before lookup");
    assert.ok(!selection.webSearch || allowed.webSearch, "unsupported search before lookup");
    const input = {
      prompt,
      locale: locale.default,
      country: country.default,
      ...hints,
      ...selection,
    };
    return {
      canonical: canonicalJson(input),
      key: `rex:c:engine-query:queryengine:v3.5:shared:2026-11-24:0:${canonicalHash(input)}`,
    };
  }
  for (const [pair, digest] of [
    [luna, "c29e8ec918fbfa5b6eee5262e7aaa390126b25c795577f2df63eebcccaa06c96"],
    [gemini, "f8b792a85586dbbde9d5ab7443ff8eea0140bc5b29edbb71592f6c766936cb78"],
  ] as const) {
    assert.deepEqual(vector(pair), vector(pair, { locale: "en-US", country: "US" }));
    assert.deepEqual(JSON.parse(vector(pair).canonical), {
      prompt,
      locale: "en-US",
      country: "US",
      ...pair,
    });
    assert.equal(
      vector(pair).key,
      `rex:c:engine-query:queryengine:v3.5:shared:2026-11-24:0:${digest}`,
    );
  }
  assert.notEqual(vector(luna).key, vector(gemini).key);
  assert.notEqual(vector(luna).key, vector({ ...luna, model: "test-only-alt" }).key);
  assert.notEqual(vector(luna).key, vector({ ...luna, webSearch: false }).key);
  assert.throws(() => vector({ ...gemini, webSearch: true }), /unsupported search/);
  assert.throws(() => vector({ ...luna, provider: "google" }), /unsupported pair/);
});

test("page entry cache vectors preserve raw URLs in both summarizer modes", async () => {
  const { tools } = parse(await readFile(join(root, policy), "utf8"));
  const tool = tools["llms-txt-generator"];
  const inputs = tool.operations.describePage.rawUrlKeyInputs;
  assert.deepEqual(inputs, { url: "/url" });
  assert.equal(tool.keyVersion, 7);
  const { info, components } = parse(
    await readFile(
      join(root, "packages/contracts/openapi/services/llms-txt-generator.yaml"),
      "utf8",
    ),
  );
  assert.equal(info.version, "5.0.0");
  const { summarizer } = components.schemas.PageEntryOptions.properties;
  const llm = { provider: "openai", model: "gpt-6-luna" };
  function keyFor(
    url: string,
    options: { summarizer?: string; provider?: string; model?: string },
  ) {
    const canonical = {
      summarizer: summarizer.default,
      ...options,
      url: new URL(url).href,
      ["$" + Object.keys(inputs)[0]]: url,
      metadata: { title: "Guide", description: null, canonicalUrl: null, language: "en" },
      content: { text: "Example guide.", markdown: "" },
    };
    return "rex:c:llms-txt-generator:describepage:v5.7:shared:-:0:" + canonicalHash(canonical);
  }
  const url = "https://example.org/guide";
  const rawVariant = "https://example.org:443/guide";
  assert.equal(new URL(url).href, new URL(rawVariant).href);
  assert.equal(keyFor(url, llm), keyFor(url, { summarizer: "llm", ...llm }));
  assert.notEqual(keyFor(url, llm), keyFor(url, { ...llm, model: "test-only-alt" }));
  assert.notEqual(keyFor(url, llm), keyFor(url, { summarizer: "extractive" }));
  assert.equal(
    keyFor(rawVariant, { summarizer: "extractive" }),
    "rex:c:llms-txt-generator:describepage:v5.7:shared:-:0:453328322744b0bc462beedd5e783aa96770e434185c673dd157cc1d6676c657",
  );
  assert.equal(
    keyFor(url, { summarizer: "extractive" }),
    "rex:c:llms-txt-generator:describepage:v5.7:shared:-:0:d2462a00a264480c5b53efd3416e4a01b8e7b5bc14a95bcb059ff58301f36fd0",
  );
  assert.equal(
    keyFor(rawVariant, llm),
    "rex:c:llms-txt-generator:describepage:v5.7:shared:-:0:05f46e87aaefee96d2a7ef0119e9e30d00529a52e7783b4e3ae28497638a2e39",
  );
  assert.equal(
    keyFor(url, llm),
    "rex:c:llms-txt-generator:describepage:v5.7:shared:-:0:b495e67e5febe10ed8e355ff5b4475d1ca8394725dfe30cee9ce371618346881",
  );
  for (const options of [llm, { summarizer: "extractive" }]) {
    assert.notEqual(keyFor(url, options), keyFor(rawVariant, options));
  }
});

test("platform contracts keep tracking separate and version the pre-implementation payloads", async () => {
  const bus = parse(await readFile(join(root, events), "utf8"));
  const broker = parse(await readFile(join(root, topology), "utf8"));
  const orchestrator = parse(
    await readFile(join(root, "packages/contracts/openapi/services/orchestrator.yaml"), "utf8"),
  );
  assert.equal(bus.info.version, "4.0.0");
  assert.equal(broker.version, 1);
  assert.equal(orchestrator.info.version, "2.0.0");
  assert.equal(bus.channels.answerCaptureRequested.address, "answer-capture.requested.{engine}");
  for (const name of ["answerCaptureRequested", "answerCaptureCompleted", "pageAuditRequested"]) {
    const { version, data } = bus.components.messages[name].payload.allOf[1].properties;
    assert.equal(version.const, 1);
    if (name.startsWith("answer")) {
      assert.ok(data.required.includes("engine"));
      assert.match(data.properties.engine.$ref, /\/EngineId$/);
    }
  }
  const platform = orchestrator.components.schemas;
  assert.ok(platform.Answer.allOf[1].required.includes("engine"));
  assert.match(platform.PromptRunOptions.properties.sentiment.$ref, /\/SentimentOptions$/);
  assert.match(platform.PromptRunScheduleSpec.properties.params.$ref, /\/PromptRunOptions$/);
  assert.match(platform.LlmsTxtSettings.allOf[1].$ref, /\/PageEntryOptions$/);
  assert.deepEqual(platform.LlmsTxtCreatePageOptions.dependentRequired, {
    provider: ["model"],
    model: ["provider"],
  });
  assert.deepEqual(platform.LlmsTxtCreatePageOptions.then.properties, { provider: false, model: false });
  assert.ok(
    !platform.LlmsTxtCreate.allOf.some(({ $ref }: { $ref?: string }) =>
      $ref?.endsWith("/LlmsTxtSettings"),
    ),
  );
});

test("answer-analysis environment docs follow the service schema", async (t) => {
  const repo = await fixture(t);
  const render = (...args: string[]) =>
    repo.run("new-tool", "--render-tool-env", "answer-analysis", ...args);
  await render("--check");
  await repo.change(
    answerDir + "/.env.example",
    "ANSWER_ANALYSIS_LUNA_ENABLED=false",
    "ANSWER_ANALYSIS_LUNA_ENABLED=true",
  );
  await assert.rejects(render("--check"), /generated environment docs are out of date/);
  await render();
  await render("--check");
});
