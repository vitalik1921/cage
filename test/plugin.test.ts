import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { copyFixture, scratchDirectory, writeFile } from "./helpers.ts";

const PLUGIN = path.resolve("plugin");
const CLI = path.resolve("src/cli.ts");
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));

/** Runs a hook script of the plugin the way Claude Code does: in the repository, with the hook's input on stdin. */
function hook(script: string, repository: string, input = "") {
  const result = spawnSync("sh", [path.join(PLUGIN, "scripts", script)], {
    cwd: repository,
    input,
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: repository, CLAUDE_PLUGIN_ROOT: PLUGIN, CAGE_BIN: `${process.execPath} ${CLI}` },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("the plugin carries the package's version, and its manifest, hooks and marketplace entry point at files that exist", () => {
  assert.equal(readJson(path.join(PLUGIN, ".claude-plugin/plugin.json")).version, readJson("package.json").version);
  assert.deepEqual(readJson(".claude-plugin/marketplace.json").plugins.map((entry: { name: string; source: string }) => [entry.name, entry.source]), [["cage", "./plugin"]]);
  const hooks = readJson(path.join(PLUGIN, "hooks/hooks.json")).hooks as Record<string, { hooks: { command: string }[] }[]>;
  for (const [event, groups] of Object.entries(hooks)) {
    for (const { command } of groups.flatMap((group) => group.hooks)) {
      const script = command.replaceAll('"', "").replace("${CLAUDE_PLUGIN_ROOT}", PLUGIN);
      assert.ok(fs.statSync(script).mode & 0o111, `${event}: ${script} is executable`);
    }
  }
  for (const skill of ["cage-design", "cage-review"]) assert.ok(fs.existsSync(path.join(PLUGIN, "skills", skill, "SKILL.md")));
});

test("without a cage project the hooks say nothing and let the agent stop", (t) => {
  const repository = scratchDirectory(t, "plugin-empty");
  writeFile(repository, "src/index.ts", "export const x = 1;\n");
  assert.deepEqual(hook("gate.sh", repository, "{}"), { code: 0, stdout: "", stderr: "" });
  assert.deepEqual(hook("context.sh", repository), { code: 0, stdout: "", stderr: "" });
});

test("the gate hook runs cage gate for each project of the repository and blocks when one blocks", (t) => {
  const repository = copyFixture(t, "vertical");
  writeFile(repository, ".cage/config.json", JSON.stringify({ version: 1 }));
  const id = `plugin-${process.pid}-${Date.now()}`;
  t.after(() => {
    for (const name of fs.readdirSync(os.tmpdir()).filter((entry) => entry.startsWith(`cage-gate-${id}-`))) fs.rmSync(path.join(os.tmpdir(), name), { force: true });
  });
  const blocked = hook("gate.sh", repository, JSON.stringify({ session_id: id, stop_hook_active: false }));
  assert.equal(blocked.code, 2);
  assert.match(blocked.stderr, new RegExp(`^cage project ${repository.replaceAll("/", "\\/")}:\\n`));
  assert.match(blocked.stderr, /^W_REVIEW_MISSING: Send \(/m);
  // The hook's input reached the gate: it counted a block for this session.
  assert.equal(fs.readdirSync(os.tmpdir()).filter((entry) => entry.startsWith(`cage-gate-${id}-`)).length, 1);

  writeFile(repository, ".cage/config.json", JSON.stringify({ version: 1, review: "off" }));
  assert.deepEqual(hook("gate.sh", repository, JSON.stringify({ session_id: id })), { code: 0, stdout: "", stderr: "" });
});

test("the context hook gives the rules and the command that runs cage for each project", (t) => {
  const repository = copyFixture(t, "vertical");
  writeFile(repository, ".cage/config.json", JSON.stringify({ version: 1 }));
  const { code, stdout } = hook("context.sh", repository);
  assert.equal(code, 0);
  assert.ok(stdout.startsWith(fs.readFileSync(path.join(PLUGIN, "rules.md"), "utf8")));
  assert.ok(stdout.includes(`- ${repository}: \`${process.execPath} ${CLI}\``));
  assert.match(stdout, /never a bare `npx cage`/);
});
