import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

const port = Number(process.env.PORT ?? 8080);
assert.ok(Number.isInteger(port) && port > 0 && port <= 65535, "PORT must be a valid port");
const endpoint = "http://127.0.0.1:" + port + "/v1/crawler-checks";
const siteUrl = "https://example.test/";
const named = ["GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-SearchBot"];
const baseRules = "Disallow: /private/\nAllow: /private/open$\n";
const commonRules = "User-agent: *\n" + baseRules;
function overlappingRules(count) {
  return Array.from(
    { length: count },
    (_, index) => "Disallow: /private/*" + index + "$\nAllow: /private/*public" + index + "$\n",
  ).join("");
}
const heavyRules = ["*", ...named]
  .map((token) => "User-agent: " + token + "\n" + baseRules + overlappingRules(15))
  .join("");
const cutoffRules = "User-agent: *\nDisallow: /" + "x".repeat(1_000) + "$";
const workloads = [
  ["representative", commonRules, "partial"],
  ["near-limit", commonRules + "#" + "\u0001".repeat(499_999 - commonRules.length), "partial"],
  ["rule-heavy", heavyRules, "partial", named],
  ["cutoff-triggering", cutoffRules, "unknown"],
  ["wildcard-heavy cutoff", commonRules + overlappingRules(70), "unknown"],
];
const warmups = 10;
const samples = 200;

for (const [name, content, expected, groups = []] of workloads) {
  const payload = JSON.stringify({
    siteUrl,
    robotsTxt: { url: siteUrl + "robots.txt", status: 200, content },
  });
  const results = [];
  let unknownRequests = 0;
  let baseline;
  for (let index = 0; index < warmups + samples; index++) {
    const start = performance.now();
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
      signal: AbortSignal.timeout(10_000),
    });
    const result = await response.json();
    const elapsed = performance.now() - start;
    assert.equal(response.status, 200);
    assert.equal(result.siteUrl, siteUrl);
    assert.equal(result.robotsTxtUrl, siteUrl + "robots.txt");
    assert.equal(result.robotsTxtStatus, 200);
    assert.ok(!Object.hasOwn(result, "checkedAt"));
    assert.ok(result.crawlers.length > 0);
    assert.ok(
      result.crawlers.every(
        ({ access, matchedGroup, robotsToken }) =>
          access === expected &&
          matchedGroup === (groups.includes(robotsToken) ? robotsToken : "*"),
      ),
    );
    if (!baseline) baseline = result;
    else assert.deepEqual(result, baseline);
    if (index < warmups) continue;
    results.push(elapsed);
    if (result.crawlers.some(({ access }) => access === "unknown")) unknownRequests++;
  }
  results.sort((a, b) => a - b);
  const p99 = results[Math.ceil(samples * 0.99) - 1];
  console.log(
    name +
      " | " +
      Buffer.byteLength(payload, "utf8") +
      " bytes | p99 " +
      p99.toFixed(2) +
      " ms | cutoff unknown " +
      unknownRequests +
      "/" +
      samples,
  );
  if (p99 >= 2_000) process.exitCode = 1;
}
