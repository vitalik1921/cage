import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { InitReport } from "../src/init.ts";
import { cli, designProject, readFile, writeFile } from "./helpers.ts";

/**
 * A project that is its own Git repository. The scratch directory lies
 * inside the harness's repository, which `init` would otherwise take for
 * the place of the agent's settings.
 */
function repository(t: TestContext, files: Record<string, string> = {}): string {
  const root = designProject(t, {}, { "package.json": JSON.stringify({ name: "p", private: true, devDependencies: { vitest: "^3" } }), ...files });
  const init = spawnSync("git", ["init", "--quiet"], { cwd: root, encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  assert.equal(fs.realpathSync(spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8" }).stdout.trim()), fs.realpathSync(root));
  return root;
}

function init(root: string, ...args: string[]): { code: number; report: InitReport } {
  const { code, stdout, stderr } = cli(root, "init", "--format", "json", ...args);
  assert.equal(stderr, "");
  return { code, report: JSON.parse(stdout) };
}
const statuses = (report: InitReport) => Object.fromEntries(report.files.map((file) => [file.path, file.status]));
const GATE = '"$CLAUDE_PROJECT_DIR"/node_modules/.bin/cage gate --root "$CLAUDE_PROJECT_DIR"/.';

test("init writes the configuration with the detected runner and the Claude Code gate, once", (t) => {
  const root = repository(t);
  const first = init(root);
  assert.equal(first.code, 0);
  assert.deepEqual(first.report.agents, ["claude"]);
  assert.equal(first.report.repository, ".");
  assert.deepEqual(statuses(first.report), { ".cage/config.json": "created", ".claude/settings.json": "created", "CLAUDE.md": "created" });
  assert.deepEqual(JSON.parse(readFile(root, ".cage/config.json")), { version: 1, tests: ["src/**/*.{test,spec}.ts"], testAdapter: "vitest", review: "warn", coverage: "warn" });
  assert.deepEqual(JSON.parse(readFile(root, ".claude/settings.json")), { hooks: { Stop: [{ hooks: [{ type: "command", command: GATE, timeout: 180 }] }] } });
  assert.ok(readFile(root, "CLAUDE.md").startsWith("# Contract harness\n"));
  assert.ok(readFile(root, "CLAUDE.md").includes("cage review --record"));

  // The configuration init wrote is one check accepts.
  assert.equal(cli(root, "check").code, 1);
  assert.match(cli(root, "check").stdout, /E_NO_DESIGNS/);

  const again = init(root);
  assert.deepEqual(statuses(again.report), { ".cage/config.json": "kept", ".claude/settings.json": "kept", "CLAUDE.md": "kept" });
  assert.equal(cli(root, "init").stdout.split("\n")[3], "init: Stop gate for claude.");
});

test("existing settings and instructions are extended, not replaced", (t) => {
  const root = repository(t, {
    ".claude/settings.json": JSON.stringify({ permissions: { allow: ["Bash(ls)"] }, hooks: { Stop: [{ hooks: [{ type: "command", command: "./other.sh" }] }], PostToolUse: [] } }),
    "CLAUDE.md": "# My project\n\nHow things are done here.\n",
    ".cage/config.json": JSON.stringify({ version: 1, testAdapter: "node:test" }),
  });
  const { report } = init(root, "--agent", "claude", "--agent", "codex");
  assert.deepEqual(statuses(report), {
    ".cage/config.json": "kept",
    ".claude/settings.json": "updated",
    "CLAUDE.md": "updated",
    ".codex/config.toml": "created",
    "AGENTS.md": "created",
  });
  assert.deepEqual(JSON.parse(readFile(root, ".claude/settings.json")), {
    permissions: { allow: ["Bash(ls)"] },
    hooks: { Stop: [{ hooks: [{ type: "command", command: "./other.sh" }] }, { hooks: [{ type: "command", command: GATE, timeout: 180 }] }], PostToolUse: [] },
  });
  assert.equal(JSON.parse(readFile(root, ".cage/config.json")).testAdapter, "node:test");
  const instructions = readFile(root, "CLAUDE.md");
  assert.ok(instructions.startsWith("# My project\n\nHow things are done here.\n\n## Contract harness\n"));
  assert.equal(readFile(root, ".codex/config.toml"), ["# cage: the agent may not finish while `cage check` fails (see CLAUDE.md / AGENTS.md).", "[[hooks.Stop]]", "[[hooks.Stop.hooks]]", 'type = "command"', 'command = "node_modules/.bin/cage gate --root ."', "timeout = 180000", ""].join("\n"));

  // A second run adds nothing to any of them.
  const before = [".claude/settings.json", "CLAUDE.md", ".codex/config.toml", "AGENTS.md"].map((file) => readFile(root, file));
  const again = init(root, "--agent", "claude", "--agent", "codex");
  assert.ok(again.report.files.every((file) => file.status === "kept"));
  assert.deepEqual([".claude/settings.json", "CLAUDE.md", ".codex/config.toml", "AGENTS.md"].map((file) => readFile(root, file)), before);

  // An existing TOML gets the block appended.
  writeFile(root, ".codex/config.toml", 'model = "o4-mini"\n');
  init(root, "--agent", "codex");
  assert.ok(readFile(root, ".codex/config.toml").startsWith('model = "o4-mini"\n\n# cage:'));
});

test("a project inside a repository gets the gate at the repository, pointing at the project", (t) => {
  const repo = repository(t, { "apps/api/package.json": JSON.stringify({ name: "api" }), "apps/api/src/a.ts": "" });
  const root = path.join(repo, "apps/api");
  const { report } = init(root, "--agent", "claude", "--agent", "codex", "--test-adapter", "node:test");
  assert.equal(report.repository, "../..");
  assert.deepEqual(statuses(report), {
    ".cage/config.json": "created",
    "../../.claude/settings.json": "created",
    "../../CLAUDE.md": "created",
    "../../.codex/config.toml": "created",
    "../../AGENTS.md": "created",
  });
  assert.equal(JSON.parse(readFile(root, ".cage/config.json")).testAdapter, "node:test");
  assert.equal(JSON.parse(readFile(repo, ".claude/settings.json")).hooks.Stop[0].hooks[0].command, '"$CLAUDE_PROJECT_DIR"/node_modules/.bin/cage gate --root "$CLAUDE_PROJECT_DIR"/apps/api');
  assert.ok(readFile(repo, ".codex/config.toml").includes('command = "node_modules/.bin/cage gate --root apps/api"'));
  assert.match(cli(root, "init").stdout, /init: Stop gate for claude from \.\.\/\.\./);
});

test("--agent none writes the configuration only; a broken settings file is a configuration error", (t) => {
  const root = repository(t);
  const only = init(root, "--agent", "none");
  assert.deepEqual(statuses(only.report), { ".cage/config.json": "created" });
  assert.deepEqual(only.report.agents, []);
  assert.match(cli(root, "init", "--agent", "none").stdout, /no Stop gate set up/);

  writeFile(root, ".claude/settings.json", "{ nope");
  const broken = init(root);
  assert.equal(broken.code, 2);
  assert.deepEqual(broken.report.diagnostics.map(({ code, file }) => ({ code, file })), [{ code: "E_CONFIG", file: ".claude/settings.json" }]);
  assert.equal(readFile(root, ".claude/settings.json"), "{ nope");

  assert.match(cli(root, "init", "--agent", "cursor").stderr, /Unknown agent "cursor"/);
  assert.match(cli(root, "init", "--test-adapter", "jest").stderr, /Unknown test adapter "jest"/);
  assert.match(cli(root, "check", "--agent", "claude").stderr, /--agent and --test-adapter are options of the init command/);
  assert.match(cli(root, "init", "--config", "x.json").stderr, /--config does not apply/);
});
