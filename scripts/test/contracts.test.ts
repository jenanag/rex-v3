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
const gitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).trim();
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
        "        extraKeyInputs: [engineModel]",
        "        normalize: {absent: collapse-whitespace}\n        extraKeyInputs: [engineModel]",
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
    "-c", "user.name=REx tests",
    "-c", "user.email=tests@rex.invalid",
    "-c", "commit.gpgSign=false",
    "commit", "-qm", "Request contract baseline",
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
  assert.equal(tools["answer-analysis"].keyVersion, 3);
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
  function cacheInput(sentiment?: { analyzers?: string[]; onUnsupportedLanguage?: string }) {
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

  const ordered = ["det:lexicon", "det:rules"];
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
});

test("engine query cache keys resolve model and search before hashing", async () => {
  const { key, tools } = parse(await readFile(join(root, policy), "utf8"));
  const { info, components } = parse(
    await readFile(join(root, "packages/contracts/openapi/services/engine-query.yaml"), "utf8"),
  );
  const { locale, country, webSearch, model } = components.schemas.EngineQuery.properties;
  const { keyVersion, operations } = tools["engine-query"];
  const { normalize, extraKeyInputs, webSearchDefaults } = operations.queryEngine;
  assert.equal(keyVersion, 4);
  assert.equal(info.version, "2.2.0");
  assert.equal(webSearch.type, "boolean");
  assert.equal(webSearch.default, undefined);
  assert.equal(model.type, "string");
  assert.equal(model.minLength, 1);
  assert.equal(model.default, undefined);
  assert.deepEqual(webSearchDefaults, { chatgpt: true, gemini: false });
  assert.ok(!components.schemas.EngineQuery.required.includes("webSearch"));
  assert.ok(!components.schemas.EngineQuery.required.includes("model"));
  assert.deepEqual(extraKeyInputs, ["engineModel"]);
  assert.ok(
    key.canonicalInput.some((step: string) => step.includes("Exclude the request model field")),
  );
  assert.equal(normalize?.prompt, undefined);

  const catalog = {
    chatgpt: {
      model: "gpt-6-luna",
      allowedModels: ["gpt-6-luna", "test-only-alt"],
      webSearch: true,
    },
    gemini: {
      model: "gemini-3.5-flash-lite",
      allowedModels: ["gemini-3.5-flash-lite"],
      webSearch: false,
    },
  };

  // Test-only caller fixture with a fixed scope, UTC window and sample.
  function cacheVector(
    prompt: string,
    hints: {
      engine?: keyof typeof catalog;
      locale?: string;
      country?: string;
      webSearch?: boolean;
      model?: string;
    } = {},
  ) {
    const { engine = "chatgpt", webSearch, model, ...region } = hints;
    const available = catalog[engine];
    const effectiveModel = model ?? available.model;
    assert.ok(available.allowedModels.includes(effectiveModel), "unsupported model before lookup");
    const effectiveSearch = webSearch ?? webSearchDefaults[engine];
    assert.ok(!effectiveSearch || available.webSearch, "unsupported search before lookup");
    const input = {
      engine,
      prompt,
      locale: locale.default,
      country: country.default,
      ...region,
      webSearch: effectiveSearch,
    };
    const resolved = { ...input, model: effectiveModel };
    const keyInput = { ...input, ["$" + extraKeyInputs[0]]: effectiveModel };
    const canonical = JSON.stringify(keyInput, Object.keys(keyInput).sort());
    const hash = createHash("sha256").update(canonical, "utf8").digest("hex");
    const key = `rex:c:engine-query:queryEngine:v${info.version.split(".")[0]}.${keyVersion}:shared:2026-11-24:0:${hash}`;
    return { resolved, canonical, key };
  }
  const prompt = "Print 'A  B' verbatim.";
  const chatgpt = cacheVector(prompt);
  const gemini = cacheVector(prompt, { engine: "gemini" });
  assert.deepEqual(chatgpt, cacheVector(prompt, { model: "gpt-6-luna" }));
  assert.deepEqual(
    gemini,
    cacheVector(prompt, { engine: "gemini", model: "gemini-3.5-flash-lite" }),
  );
  for (const [vector, engine, model, webSearch, hash] of [
    [
      chatgpt,
      "chatgpt",
      "gpt-6-luna",
      true,
      "39e9048649a1d56787003f1170e1502f8a5870120c9e43c8392be66d96346789",
    ],
    [
      gemini,
      "gemini",
      "gemini-3.5-flash-lite",
      false,
      "6fed0e5b283798322f38ba66cac4b9a7bffc561553a760cf28228c1289cbab45",
    ],
  ] as const) {
    assert.deepEqual(vector.resolved, {
      engine,
      prompt,
      locale: "en-US",
      country: "US",
      model,
      webSearch,
    });
    assert.equal(
      vector.canonical,
      JSON.stringify({
        $engineModel: model,
        country: "US",
        engine,
        locale: "en-US",
        prompt,
        webSearch,
      }),
    );
    assert.equal(vector.key, `rex:c:engine-query:queryEngine:v2.4:shared:2026-11-24:0:${hash}`);
  }
  assert.deepEqual(chatgpt, cacheVector(prompt, { locale: "en-US", country: "US" }));
  assert.notEqual(chatgpt.key, cacheVector("Print 'A B' verbatim.").key);
  assert.notEqual(chatgpt.key, cacheVector(prompt, { country: "CA" }).key);
  assert.notEqual(chatgpt.key, cacheVector(prompt, { model: "test-only-alt" }).key);
  assert.deepEqual(chatgpt, cacheVector(prompt, { webSearch: true }));
  assert.notEqual(chatgpt.key, cacheVector(prompt, { webSearch: false }).key);
  assert.deepEqual(gemini, cacheVector(prompt, { engine: "gemini", webSearch: false }));
  assert.throws(
    () => cacheVector(prompt, { engine: "gemini", webSearch: true }),
    /unsupported search/,
  );
  assert.throws(() => cacheVector(prompt, { model: "unlisted" }), /unsupported model/);
  assert.throws(
    () => cacheVector(prompt, { engine: "gemini", model: "gpt-6-luna" }),
    /unsupported model/,
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
