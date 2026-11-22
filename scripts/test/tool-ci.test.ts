import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { parse, stringify } from "yaml";

const exec = promisify(execFile);
const root = resolve(".");

async function fixture(t: { after: (callback: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "rex-ci-fixture-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const put = async (path: string, content: string) => {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  };
  const git = async (...args: string[]) => (await exec("git", args, { cwd: dir })).stdout.trim();
  const run = async (...args: string[]) =>
    (
      await exec(
        process.execPath,
        [
          join(root, "node_modules/tsx/dist/cli.mjs"),
          join(root, "scripts/lib/tool-ci.ts"),
          ...args,
        ],
        { cwd: dir },
      )
    ).stdout.trim();
  const commit = async (message: string) => {
    await git("add", "-A");
    await git(
      "-c",
      "user.name=CI fixture",
      "-c",
      "user.email=ci@example.invalid",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-qm",
      message,
    );
    return git("rev-parse", "HEAD");
  };
  const manifestFile = "packages/contracts/vendoring.yaml";
  const manifest = parse(await readFile(join(root, manifestFile), "utf8"));
  await symlink(join(root, "node_modules"), join(dir, "node_modules"), "dir");
  await put(".gitignore", "node_modules/\n");
  const echo = await readFile(join(root, "packages/contracts/openapi/templates/echo.yaml"), "utf8");
  await put("docs/conventions.md", await readFile(join(root, "docs/conventions.md"), "utf8"));
  for (const name of ["foo", "bar"]) {
    manifest.services[name] = { language: "ts", example: true };
    await put(
      "packages/contracts/openapi/services/" + name + ".yaml",
      echo.replace("name: echo-template", "name: " + name),
    );
    await put(
      "services/" + name + "/package.json",
      '{"name":"' + name + '","dependencies":{"fastify":"5.12.8"}}',
    );
    await put("services/" + name + "/package-lock.json", "{}");
  }
  await put(manifestFile, stringify(manifest));
  await mkdir(join(dir, "services/_template"), { recursive: true });
  await cp(
    join(root, "services/_template/src/domain/echo.ts"),
    join(dir, "services/_template/echo.ts"),
  );
  await git("init", "-qb", "main");
  return { run, put, commit };
}

test("CI matrix selects one changed tool and expands for a template change", async (t) => {
  const repo = await fixture(t);
  const initial = await repo.commit("matrix fixture");
  assert.deepEqual(JSON.parse(await repo.run("matrix", "--base", initial)).include, []);
  await repo.put("services/foo/src/index.ts", "export const foo = true;\n");
  const oneTool = await repo.commit("one tool changed");
  assert.deepEqual(JSON.parse(await repo.run("matrix", "--base", initial)).include, [
    { name: "foo", language: "ts" },
  ]);
  await repo.put("services/_template/src/index.ts", "export const template = true;\n");
  await repo.commit("template changed");
  assert.deepEqual(JSON.parse(await repo.run("matrix", "--base", oneTool)).include, [
    { name: "_template", language: "ts" },
    { name: "foo", language: "ts" },
    { name: "bar", language: "ts" },
  ]);
});

test("tool checks reject nonportable dependencies and cross-tool domain copies", async (t) => {
  const repo = await fixture(t);
  await repo.run("manifest", "foo");
  await repo.put("services/foo/package.json", '{"dependencies":{"fastify":"workspace:*"}}');
  await assert.rejects(
    repo.run("manifest", "foo"),
    /services\/foo\/package\.json: fastify must use an exact public npm version/,
  );
  await repo.put("services/foo/package.json", '{"dependencies":{"axios":"1.0.0"}}');
  await assert.rejects(
    repo.run("manifest", "foo"),
    /services\/foo\/package\.json: runtime dependency axios is unapproved/,
  );

  const business =
    "export function compute(x: number) {\n" +
    Array.from(
      { length: 16 },
      (_, index) => "  x = x * " + (index + 2) + " + " + index * 13 + ";",
    ).join("\n") +
    "\n  return x;\n}\n";
  const foo = "services/foo/src/domain/calculation.ts";
  const bar = "services/bar/src/domain/calculation.ts";
  await repo.put(bar, business);
  const base = await repo.commit("one domain implementation");
  await repo.put(foo, business);
  await repo.commit("copied domain logic");
  await assert.rejects(
    repo.run("duplicates", "--base", base),
    /calculation\.ts.*duplicate across tools/,
  );

  const metadata = JSON.stringify({
    files: { "src/domain/calculation.ts": { sha256: "fixture" } },
  });
  await repo.put("services/foo/.template.json", metadata);
  await repo.put("services/bar/.template.json", metadata);
  await repo.commit("exclude tracked template boilerplate");
  await repo.run("duplicates", "--base", base);
});
