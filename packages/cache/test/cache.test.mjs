import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { deriveCacheKey } from "@rex/cache";

const load = (path) => parse(readFileSync(new URL("../../../" + path, import.meta.url), "utf8"));
const policy = load("packages/contracts/cache/policy.yaml");
const contractFor = new Map();
const timestamp = Date.parse("2026-11-24T06:15:00Z");
const luna = { provider: "openai", model: "gpt-6-luna" };
const gemini = { provider: "google", model: "gemini-3.5-flash-lite" };
const prompt = "Print 'A  B' verbatim.";

function derive(tool, operationId, request, options) {
  if (!contractFor.has(tool)) {
    const path = Object.hasOwn(policy.external, tool)
      ? `packages/contracts/handoff/${tool}.openapi.yaml`
      : `services/${tool}/contract/openapi.yaml`;
    contractFor.set(tool, load(path));
  }
  return deriveCacheKey({
    tool,
    operationId,
    policy,
    contract: contractFor.get(tool),
    request,
    timestamp,
    ...options,
  });
}

function expectVector(result, canonical, key) {
  assert.equal(result.status, "cacheable");
  assert.deepEqual(result.canonicalBytes, Buffer.from(canonical, "utf8"));
  assert.equal(result.key, key);
  assert.deepEqual(result.diagnostics, []);
}

function query(selection = luna, hints = {}, options) {
  return derive(
    "engine-query",
    "queryEngine",
    {
      ...selection,
      webSearch: selection.provider === "openai",
      prompt,
      ...hints,
    },
    options,
  );
}

test("queryEngine preserves both contract golden keys and selects defaults without changing the request", () => {
  const vectors = [
    [
      luna,
      '{"country":"US","locale":"en-US","model":"gpt-6-luna","prompt":"Print \'A  B\' verbatim.","provider":"openai","webSearch":true}',
      "c29e8ec918fbfa5b6eee5262e7aaa390126b25c795577f2df63eebcccaa06c96",
    ],
    [
      gemini,
      '{"country":"US","locale":"en-US","model":"gemini-3.5-flash-lite","prompt":"Print \'A  B\' verbatim.","provider":"google","webSearch":false}',
      "f8b792a85586dbbde9d5ab7443ff8eea0140bc5b29edbb71592f6c766936cb78",
    ],
  ];
  for (const [pair, canonical, digest] of vectors) {
    const key = "rex:c:engine-query:queryengine:v3.5:shared:2026-11-24:0:" + digest;
    expectVector(query(pair), canonical, key);
    expectVector(query(pair, { country: "US", locale: "en-US" }), canonical, key);
  }
  assert.notEqual(query().key, query(gemini).key);
  assert.notEqual(query().key, query({ ...luna, model: "test-only-alt" }).key);
  assert.notEqual(query().key, query(luna, { webSearch: false }).key);
  assert.notEqual(query().key, query(luna, { prompt: "Print 'A B' verbatim." }).key);
  const body = Object.freeze({ ...luna, prompt, webSearch: true });
  derive("engine-query", "queryEngine", body);
  assert.deepEqual(body, { ...luna, prompt, webSearch: true });
  assert.equal(derive("engine-query", "queryengine", body).status, "uncacheable");
});

test("describePage preserves all four golden keys and raw URLs in both modes", () => {
  const canonicalUrl = "https://example.org/guide";
  const raw = "https://example.org:443/guide";
  const options = [
    [
      luna,
      ',"model":"gpt-6-luna","provider":"openai","summarizer":"llm"',
      [
        "b495e67e5febe10ed8e355ff5b4475d1ca8394725dfe30cee9ce371618346881",
        "05f46e87aaefee96d2a7ef0119e9e30d00529a52e7783b4e3ae28497638a2e39",
      ],
    ],
    [
      { summarizer: "extractive" },
      ',"summarizer":"extractive"',
      [
        "d2462a00a264480c5b53efd3416e4a01b8e7b5bc14a95bcb059ff58301f36fd0",
        "453328322744b0bc462beedd5e783aa96770e434185c673dd157cc1d6676c657",
      ],
    ],
  ];
  const payload = {
    metadata: { title: "Guide", description: null, canonicalUrl: null, language: "en" },
    content: { text: "Example guide.", markdown: "" },
  };
  const describe = (url, selection) =>
    derive("llms-txt-generator", "describePage", {
      ...payload,
      url,
      ...selection,
    });
  for (const [selection, fields, digests] of options) {
    for (const [i, url] of [canonicalUrl, raw].entries()) {
      const canonical = `{"$url":"${url}","content":{"markdown":"","text":"Example guide."},"metadata":{"canonicalUrl":null,"description":null,"language":"en","title":"Guide"}${fields},"url":"${canonicalUrl}"}`;
      expectVector(
        describe(url, selection),
        canonical,
        "rex:c:llms-txt-generator:describepage:v5.7:shared:-:0:" + digests[i],
      );
    }
  }
  assert.deepEqual(describe(raw, luna), describe(raw, { ...luna, summarizer: "llm" }));
  assert.notEqual(describe(raw, luna).key, describe(raw, { ...luna, model: "test-only-alt" }).key);
});

test("analyzeAnswer preserves nested defaults, analyzer order, and explicit empty selection", () => {
  const text = "Acme is a top pick, but Acme is bad.";
  const brands = [{ key: "acme", kind: "primary", name: "Acme", aliases: [], domains: [] }];
  const analyze = (sentiment) =>
    derive(
      "answer-analysis",
      "analyzeAnswer",
      sentiment === undefined ? { text, brands } : { text, brands, sentiment },
    );
  const canonical = (analyzers) =>
    `{"brands":[{"aliases":[],"domains":[],"key":"acme","kind":"primary","name":"Acme"}],"sentiment":{"analyzers":${analyzers},"onUnsupportedLanguage":"fallback"},"text":"${text}"}`;
  for (const [sentiment, selectors, digest] of [
    [
      undefined,
      '["det:lexicon"]',
      "e709689548ff05e5ed3bd1e4a1122022e8ea6a5d6af07adf52ea9c5391406b5a",
    ],
    [
      { analyzers: ["det:lexicon", luna] },
      '["det:lexicon",{"model":"gpt-6-luna","provider":"openai"}]',
      "024482406262eae9ee6f712fd99794db43fe0bc9e4202a3a1f6479d48666c70c",
    ],
    [
      { analyzers: [luna, "det:lexicon"] },
      '[{"model":"gpt-6-luna","provider":"openai"},"det:lexicon"]',
      "8a527de041b4866e21df3e475e2d3affbe135bb1675344e19ae06868c71630c5",
    ],
  ]) {
    expectVector(
      analyze(sentiment),
      canonical(selectors),
      "rex:c:answer-analysis:analyzeanswer:v3.5:shared:-:0:" + digest,
    );
  }
  assert.deepEqual(analyze(), analyze({}));
  assert.deepEqual(
    analyze(),
    analyze({ analyzers: ["det:lexicon"], onUnsupportedLanguage: "fallback" }),
  );
  assert.notEqual(analyze().key, analyze({ analyzers: [] }).key);
  assert.equal(analyze({ analyzers: [] }).canonicalBytes.toString(), canonical("[]"));
  const normalizedBrand = {
    ...brands[0],
    aliases: ["Zulu", "alpha"],
    domains: ["www.EXAMPLE.ORG", "B.test"],
  };
  const result = derive("answer-analysis", "analyzeAnswer", { text, brands: [normalizedBrand] });
  assert.deepEqual(JSON.parse(result.canonicalBytes).brands[0], {
    ...normalizedBrand,
    aliases: ["Zulu", "alpha"],
    domains: ["www.example.org", "b.test"],
  });
});

test("crawler trailing dots survive in both raw URL inputs", () => {
  for (const [siteHost, robotsHost, digest] of [
    [
      "example.test",
      "example.test",
      "68662b36f9163651aa0a33fe91c7a899ae817a708a170f1c2a36d17d844c7744",
    ],
    [
      "example.test.",
      "example.test",
      "58c088cd33be49947eaa07005e56012e6df4492f7022a4cc2e348248a0a51045",
    ],
    [
      "example.test",
      "example.test.",
      "262dc58650bc3e99247c80b73fc14fd6bbe7fc1c69e72a6440a298cf63c2294c",
    ],
  ]) {
    const siteUrl = `https://${siteHost}/`;
    const url = `https://${robotsHost}/robots.txt`;
    expectVector(
      derive("content-auditor", "checkCrawlerAccess", {
        siteUrl,
        robotsTxt: { url, status: 404, content: null },
      }),
      `{"$robotsTxtUrl":"${url}","$siteUrl":"${siteUrl}","robotsTxt":{"content":null,"status":404,"url":"https://example.test/robots.txt"},"siteUrl":"https://example.test/"}`,
      "rex:c:content-auditor:checkcrawleraccess:v2.3:shared:-:0:" + digest,
    );
  }
});

test("external contract defaults, oneOf URL types, and unique array ordering participate", () => {
  const extract = (request) => derive("content-extractor", "extractContent", request);
  const vector = extract({
    url: "https://EXAMPLE.org:443/guide#top",
    include: ["robotsTxt", "llmsTxt"],
  });
  expectVector(
    vector,
    '{"include":["llmsTxt","robotsTxt"],"respectRobotsTxt":false,"url":"https://example.org/guide"}',
    "rex:c:content-extractor:extractcontent:v2.1:shared:-:0:155b7bd02e10f40f74cbee6778705b75923490ac264ef017d45bb4ade0e89ec4",
  );
  assert.equal(vector.ttlSeconds, 3600);
  assert.deepEqual(
    vector,
    extract({
      url: "https://example.org/guide",
      include: ["llmsTxt", "robotsTxt"],
      respectRobotsTxt: false,
    }),
  );
  assert.deepEqual(
    extract({ url: "https://example.org/guide" }),
    extract({ url: "https://example.org/guide", include: [] }),
  );
  const html = extract({
    html: "<p>Guide</p>",
    baseUrl: "https://EXAMPLE.ORG.:443/a/../guide?x=3&x=1#top",
  });
  assert.equal(
    html.canonicalBytes.toString(),
    '{"baseUrl":"https://example.org/a/../guide?x=3&x=1","html":"<p>Guide</p>","include":[],"respectRobotsTxt":false}',
  );
  for (const url of [
    "https:///example.org",
    "https://example.org:65536/",
    "https://example.org/%ZZ",
  ]) {
    assert.deepEqual(extract({ url }), {
      status: "uncacheable",
      reason: "unsafe_input",
      diagnostics: [],
    });
  }
});

test("bodyless discovery has a canonical empty object", () => {
  expectVector(
    derive("engine-query", "listEngines"),
    "{}",
    "rex:c:engine-query:listengines:v3.5:shared:-:0:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
  );
});

test("customer and environment overrides resolve each field and isolate tenants", () => {
  const orgId = "org_01JD3Z8XQK5V7N2M4P6R8T0W2Y";
  const customerOverrides = {
    "*": { scope: "tenant", window: "PT1H" },
    "engine-query.queryEngine": { window: "P7D" },
  };
  const environmentOverrides = {
    tools: { "engine-query": { operations: { queryEngine: { scope: "shared", window: "P1D" } } } },
  };
  const options = { customerOverrides, environmentOverrides, orgId, variant: 12 };
  const result = query(luna, {}, options);
  assert.equal(result.scope, "tenant");
  assert.equal(result.window, "P7D");
  assert.equal(
    result.key,
    "rex:c:engine-query:queryengine:v3.5:t-org_01jd3z8xqk5v7n2m4p6r8t0w2y:2026-11-23:12:c29e8ec918fbfa5b6eee5262e7aaa390126b25c795577f2df63eebcccaa06c96",
  );
  assert.notEqual(
    result.key,
    query(luna, {}, { ...options, orgId: "org_01JD3Z8XQK5V7N2M4P6R8T0W2Z" }).key,
  );
  assert.deepEqual(query(luna, {}, { ...options, orgId: undefined }), {
    status: "uncacheable",
    reason: "missing_org_id",
    diagnostics: [],
  });
  assert.equal(query(luna, {}, { environmentOverrides, orgId }).key, query().key);
  assert.equal(query(luna, {}, { customerOverrides: { "*": { window: "PT1H" } } }).window, "PT1H");
  assert.equal(
    query(
      luna,
      {},
      {
        customerOverrides: { "engine-query.queryEngine": { scope: "tenant" } },
        environmentOverrides: {
          tools: { "engine-query": { operations: { queryEngine: { window: "PT1H" } } } },
        },
        orgId,
      },
    ).window,
    "PT1H",
  );
});

test("invalid overrides diagnose and fall through; TTLs clamp at both policy limits", () => {
  const extract = (options) =>
    derive("content-extractor", "extractContent", { url: "https://example.org/" }, options);
  const environmentOverrides = {
    external: {
      "content-extractor": {
        keyVersion: 100,
        operations: { extractContent: { scope: "tenant", ttl: "P91D" } },
      },
    },
  };
  const orgId = "org_01JD3Z8XQK5V7N2M4P6R8T0W2Y";
  const low = extract({
    orgId,
    environmentOverrides,
    customerOverrides: {
      "content-extractor.extractContent": {
        ttl: "PT20S",
        scope: "shared",
        window: "PT1H",
        rawUrlKeyInputs: {},
      },
    },
  });
  assert.equal(low.scope, "tenant");
  assert.equal(low.ttlSeconds, 60);
  assert.match(low.key, /:v2\.1:t-org_/);
  assert.deepEqual(
    low.diagnostics.map(({ code, location }) => [code, location]),
    [
      ["invalid_override", "external.content-extractor.keyVersion"],
      ["ttl_clamped", "content-extractor.extractContent.ttl"],
      ["invalid_override", "content-extractor.extractContent.scope"],
      ["invalid_override", "content-extractor.extractContent.window"],
      ["invalid_override", "content-extractor.extractContent.rawUrlKeyInputs"],
      ["ttl_clamped", "external.content-extractor.operations.extractContent.ttl"],
    ],
  );
  assert.equal(extract({ orgId, environmentOverrides }).ttlSeconds, 90 * 86400);
  assert.equal(
    extract({
      orgId,
      environmentOverrides,
      customerOverrides: {
        "content-extractor.extractContent": { ttl: "P1M" },
        "*": { ttl: "PT2M" },
      },
    }).ttlSeconds,
    120,
  );
  const invalidWindow = query(
    luna,
    {},
    {
      customerOverrides: {
        "engine-query.queryEngine": { window: "P2D", ttl: "PT1H" },
        "*": { window: "PT1H" },
      },
    },
  );
  assert.equal(invalidWindow.window, "PT1H");
  assert.deepEqual(
    invalidWindow.diagnostics.map(({ code }) => code),
    ["invalid_override", "invalid_override"],
  );
});

test("explicit timestamps select UTC hour, midnight, and Monday buckets", () => {
  for (const [window, before, at, previous, next] of [
    ["PT1H", "2026-11-23T00:59:59.999Z", "2026-11-23T01:00:00Z", "2026-11-23t00", "2026-11-23t01"],
    ["P1D", "2026-11-22T23:59:59.999Z", "2026-11-23T00:00:00Z", "2026-11-22", "2026-11-23"],
    ["P7D", "2026-11-22T23:59:59.999Z", "2026-11-23T00:00:00Z", "2026-11-16", "2026-11-23"],
    ["P7D", "2023-12-31T23:59:59.999Z", "2024-01-01T00:00:00Z", "2023-12-25", "2024-01-01"],
  ]) {
    for (const [when, bucket] of [
      [before, previous],
      [at, next],
    ]) {
      const result = query(
        luna,
        {},
        {
          timestamp: Date.parse(when),
          customerOverrides: { "*": { window } },
        },
      );
      assert.equal(
        result.key,
        `rex:c:engine-query:queryengine:v3.5:shared:${bucket}:0:c29e8ec918fbfa5b6eee5262e7aaa390126b25c795577f2df63eebcccaa06c96`,
      );
    }
  }
});

test("policy normalization and declared extras apply in order; JCS emits canonical UTF-8", () => {
  const customPolicy = structuredClone(policy);
  Object.assign(customPolicy.tools["engine-query"].operations.queryEngine, {
    normalize: { "/prompt": "collapse-whitespace" },
    extraKeyInputs: ["context"],
  });
  const context = { "€": -0, "\r": 1e-7, "😀": "e\u0301", דּ: 333333333.33333329 };
  const options = { policy: customPolicy, extraKeyInputs: { context, ignored: true } };
  const result = query(luna, { prompt: " \tA  B\n" }, options);
  assert.deepEqual(
    result.canonicalBytes,
    Buffer.from(
      '{"$context":{"\\r":1e-7,"€":0,"😀":"e\u0301","דּ":333333333.3333333},"country":"US","locale":"en-US","model":"gpt-6-luna","prompt":"A B","provider":"openai","webSearch":true}',
      "utf8",
    ),
  );
  const uncacheable = { status: "uncacheable", reason: "unsafe_input", diagnostics: [] };
  assert.deepEqual(query(luna, {}, { policy: customPolicy }), uncacheable);
  assert.deepEqual(query(luna, { prompt: "\uDEAD" }, options), uncacheable);
  assert.deepEqual(
    query(luna, {}, { ...options, extraKeyInputs: { context: Infinity } }),
    uncacheable,
  );
});
