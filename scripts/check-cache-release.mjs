import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "rex-cache-release-"));
const checkout = join(scratch, "checkout");
const cache = join(checkout, "packages/cache");
const consumer = join(scratch, "consumer");
const changeset = join(root, "node_modules/.bin/changeset");
const version = "0.1.0";

function run(command, args, cwd = root) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

function json(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

try {
  const head = run("git", ["rev-parse", "HEAD"]);
  run("git", ["clone", "--quiet", "--shared", "--no-tags", "--no-checkout", root, checkout]);
  run("git", ["checkout", "--quiet", "--detach", head], checkout);
  for (const path of ["node_modules", "packages/cache/node_modules"]) {
    symlinkSync(join(root, path), join(checkout, path), "dir");
  }

  const plan = join(scratch, "plan.json");
  run(changeset, ["status", "--since=HEAD", "--output", plan], checkout);
  assert.deepEqual(
    json(plan).releases.map(({ name, type, oldVersion, newVersion }) => ({
      name,
      type,
      oldVersion,
      newVersion,
    })),
    [{ name: "@rex/cache", type: "minor", oldVersion: "0.0.0", newVersion: version }],
  );
  run(changeset, ["version"], checkout);
  assert.equal(json(join(cache, "package.json")).version, version);
  assert.match(readFileSync(join(cache, "CHANGELOG.md"), "utf8"), /^## 0\.1\.0$/m);
  assert.match(readFileSync(join(cache, "CHANGELOG.md"), "utf8"), /Redis 7 backend/);
  assert.equal(run("git", ["tag", "--list"], checkout), "");
  console.log(`Changesets planned only @rex/cache@${version} and generated its changelog`);

  run("npm", ["run", "build"], cache);
  const [pack] = JSON.parse(
    run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", scratch], cache),
  );
  const files = pack.files.map(({ path }) => path);
  for (const path of [
    "package.json",
    "README.md",
    "CHANGELOG.md",
    "dist/index.js",
    "dist/index.d.ts",
  ]) {
    assert.ok(files.includes(path), `Missing from tarball: ${path}`);
  }
  assert.ok(
    files.every((path) =>
      /^(?:package\.json|README\.md|CHANGELOG\.md|dist\/[\w-]+\.(?:js|d\.ts))$/.test(path),
    ),
  );
  assert.equal(pack.name, "@rex/cache");
  assert.equal(pack.version, version);

  mkdirSync(consumer);
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  const userConfig = join(scratch, "user.npmrc");
  const globalConfig = join(scratch, "global.npmrc");
  writeFileSync(userConfig, "");
  writeFileSync(globalConfig, "");
  run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefer-offline",
      "--registry=https://registry.npmjs.org",
      "--userconfig",
      userConfig,
      "--globalconfig",
      globalConfig,
      join(scratch, pack.filename),
    ],
    consumer,
  );
  const installed = json(join(consumer, "node_modules/@rex/cache/package.json"));
  assert.equal(installed.version, version);
  assert.equal(installed.private, true);
  assert.equal(installed.engines.node, "26.13.1");
  assert.deepEqual(installed.repository, {
    type: "git",
    url: "git+https://github.com/jenanag/rex-v3.git",
    directory: "packages/cache",
  });
  assert.deepEqual(installed.exports["."], {
    types: "./dist/index.d.ts",
    default: "./dist/index.js",
  });

  writeFileSync(
    join(consumer, "smoke.mjs"),
    `
import assert from "node:assert/strict";
import * as cache from "@rex/cache";
assert.deepEqual(Object.keys(cache).sort(), [
  "CacheArchiveError", "CacheDeadlineError", "RedisCacheBackend", "callWithCache", "deriveCacheKey"
]);
for (const entry of Object.values(cache)) assert.equal(typeof entry, "function");
`,
  );
  run(process.execPath, ["smoke.mjs"], consumer);
  writeFileSync(
    join(consumer, "smoke.ts"),
    `
import { callWithCache, deriveCacheKey, RedisCacheBackend } from "@rex/cache";
import type { CacheBackend, CacheCallOptions, CacheKeyOptions } from "@rex/cache";
const backend: CacheBackend = new RedisCacheBackend({
  url: "redis://127.0.0.1", ioTimeoutMs: 100, maxValueBytes: 1000
});
export function smoke(key: CacheKeyOptions, options: CacheCallOptions<string>) {
  return [deriveCacheKey(key), callWithCache({ ...options, backend })];
}
`,
  );
  writeFileSync(
    join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "nodenext",
        target: "esnext",
        strict: true,
        noEmit: true,
        types: ["node"],
        typeRoots: [join(root, "packages/cache/node_modules/@types")],
      },
      files: ["smoke.ts"],
    }),
  );
  run(join(root, "packages/cache/node_modules/.bin/tsc"), ["--project", "tsconfig.json"], consumer);
  console.log(
    `Packed ${pack.filename} (${files.length} files, ${pack.size} bytes) and verified runtime exports and types in a separate consumer`,
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
