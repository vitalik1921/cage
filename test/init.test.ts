import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { InitReport } from "../src/init.ts";
import { cli, designProject, readFile, writeFile } from "./helpers.ts";

/**
 * A project that is its own Git repository, with `cage` installed at its
 * root. The scratch directory lies inside the harness's repository, which
 * `init` would otherwise take for the place of the agent's settings.
 */
function repository(t: TestContext, files: Record<string, string> = {}, install = "node_modules/.bin/cage"): string {
  const root = designProject(t, {}, { "package.json": JSON.stringify({ name: "p", private: true, devDependencies: { vitest: "^3" } }), ...files });
  if (install !== "") writeFile(root, install, "#!/bin/sh\n");
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
const settings = (root: string) => JSON.parse(readFile(root, ".claude/settings.json"));
const GATE = '"$CLAUDE_PROJECT_DIR/node_modules/.bin/cage" gate --root "$CLAUDE_PROJECT_DIR/."';
const CODEX_BLOCK = [
  "# cage: the agent may not finish while `cage check` fails (see AGENTS.md).",
  "[[hooks.Stop]]",
  "[[hooks.Stop.hooks]]",
  'type = "command"',
  "command = '\"node_modules/.bin/cage\" gate --root \".\"'",
  "timeout = 180",
  "",
].join("\n");

test("init writes the configuration with the detected runner and the Claude Code gate, once", (t) => {
  const root = repository(t);
  const first = init(root);
  assert.equal(first.code, 0);
  assert.deepEqual(first.report.diagnostics, []);
  assert.deepEqual(first.report.agents, ["claude"]);
  assert.equal(first.report.repository, ".");
  assert.deepEqual(statuses(first.report), {
    ".cage/config.json": "created",
    ".claude/settings.json": "created",
    "CLAUDE.md": "created",
    ".claude/skills/cage-design/SKILL.md": "created",
    ".claude/skills/cage-review/SKILL.md": "created",
  });
  assert.ok(readFile(root, ".claude/skills/cage-design/SKILL.md").startsWith("---\nname: cage-design\n"));
  assert.ok(readFile(root, "CLAUDE.md").includes("`cage-design`"));
  assert.deepEqual(JSON.parse(readFile(root, ".cage/config.json")), {
    version: 1,
    tests: ["src/**/*.{test,spec,e2e-spec}.ts", "tests/**/*.{test,spec,e2e-spec}.ts"],
    testAdapter: "vitest",
    review: "warn",
    coverage: "warn",
  });
  assert.deepEqual(settings(root), { hooks: { Stop: [{ hooks: [{ type: "command", command: GATE, timeout: 180 }] }] } });
  assert.ok(readFile(root, "CLAUDE.md").startsWith("# Contract harness\n"));
  assert.ok(readFile(root, "CLAUDE.md").includes("cage review --record"));

  // The configuration init wrote is one check accepts.
  assert.equal(cli(root, "check").code, 1);
  assert.match(cli(root, "check").stdout, /E_NO_DESIGNS/);

  // A skill the project edited is its own.
  writeFile(root, ".claude/skills/cage-review/SKILL.md", "---\nname: cage-review\ndescription: ours\n---\n");
  const again = init(root);
  assert.deepEqual(statuses(again.report), {
    ".cage/config.json": "kept",
    ".claude/settings.json": "kept",
    "CLAUDE.md": "kept",
    ".claude/skills/cage-design/SKILL.md": "kept",
    ".claude/skills/cage-review/SKILL.md": "kept",
  });
  assert.equal(readFile(root, ".claude/skills/cage-review/SKILL.md"), "---\nname: cage-review\ndescription: ours\n---\n");
  assert.ok(cli(root, "init").stdout.split("\n").includes("init: Stop gate for claude."));
});

test("existing settings and instructions are extended, not replaced, and a gate written by hand is recognised", (t) => {
  const root = repository(t, {
    ".claude/settings.json": JSON.stringify({ permissions: { allow: ["Bash(ls)"] }, hooks: { Stop: [{ hooks: [{ type: "command", command: "./other.sh" }] }], PostToolUse: [] } }),
    "CLAUDE.md": "# My project\r\n\r\nHow things are done here.\r\n",
    ".cage/config.json": JSON.stringify({ version: 1, testAdapter: "node:test" }),
  });
  const { report } = init(root, "--agent", "claude", "--agent", "codex");
  assert.deepEqual(statuses(report), {
    ".cage/config.json": "kept",
    ".claude/settings.json": "updated",
    "CLAUDE.md": "updated",
    ".claude/skills/cage-design/SKILL.md": "created",
    ".claude/skills/cage-review/SKILL.md": "created",
    ".codex/config.toml": "created",
    "AGENTS.md": "created",
    ".agents/skills/cage-design/SKILL.md": "created",
    ".agents/skills/cage-review/SKILL.md": "created",
  });
  assert.deepEqual(settings(root), {
    permissions: { allow: ["Bash(ls)"] },
    hooks: { Stop: [{ hooks: [{ type: "command", command: "./other.sh" }] }, { hooks: [{ type: "command", command: GATE, timeout: 180 }] }], PostToolUse: [] },
  });
  assert.equal(JSON.parse(readFile(root, ".cage/config.json")).testAdapter, "node:test");
  // The section follows the file's own line endings.
  const instructions = readFile(root, "CLAUDE.md");
  assert.ok(instructions.startsWith("# My project\r\n\r\nHow things are done here.\r\n\r\n## Contract harness\r\n"));
  assert.ok(!instructions.includes("\r\n\n"));
  assert.equal(readFile(root, ".codex/config.toml"), CODEX_BLOCK);

  // A second run adds nothing to any of them.
  const before = [".claude/settings.json", "CLAUDE.md", ".codex/config.toml", "AGENTS.md"].map((file) => readFile(root, file));
  const again = init(root, "--agent", "claude", "--agent", "codex");
  assert.ok(again.report.files.every((file) => file.status === "kept"));
  assert.deepEqual([".claude/settings.json", "CLAUDE.md", ".codex/config.toml", "AGENTS.md"].map((file) => readFile(root, file)), before);

  // A gate that was written by hand, with its own quoting, counts as the gate of this project.
  writeFile(root, ".claude/settings.json", JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: '"$CLAUDE_PROJECT_DIR"/node_modules/.bin/cage gate --root "$CLAUDE_PROJECT_DIR"' }] }] } }));
  assert.equal(init(root).report.files.find((file) => file.path === ".claude/settings.json")?.status, "kept");

  // An existing TOML with `[[hooks.Stop]]` entries gets the block appended; one with a `[hooks]` table cannot be changed here.
  writeFile(root, ".codex/config.toml", 'model = "o4-mini"\n[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ncommand = "./lint.sh"\n');
  init(root, "--agent", "codex");
  assert.ok(readFile(root, ".codex/config.toml").startsWith('model = "o4-mini"\n[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ncommand = "./lint.sh"\n\n# cage:'));
  writeFile(root, ".codex/config.toml", '[hooks]\nStop = [{ hooks = [{ command = "./lint.sh" }] }]\n');
  const table = init(root, "--agent", "codex");
  assert.equal(table.code, 2);
  assert.deepEqual(table.report.diagnostics.map(({ code, file }) => ({ code, file })), [{ code: "E_CONFIG", file: ".codex/config.toml" }]);
  assert.ok(table.report.diagnostics[0].message.includes("add the Stop hook by hand:\n# cage:"));
  assert.equal(readFile(root, ".codex/config.toml"), '[hooks]\nStop = [{ hooks = [{ command = "./lint.sh" }] }]\n');
});

test("a project inside a repository gets the gate at the repository, naming the project and the cage it has installed", (t) => {
  const repo = repository(t, { "apps/my api/package.json": JSON.stringify({ name: "api" }), "apps/my api/src/a.ts": "", "apps/web/src/b.ts": "" }, "");
  // The harness is installed in the project, not at the repository root; a space in the path is kept whole.
  writeFile(repo, "apps/my api/node_modules/.bin/cage", "#!/bin/sh\n");
  const root = path.join(repo, "apps/my api");
  const { report } = init(root, "--agent", "claude", "--agent", "codex", "--test-adapter", "node:test");
  assert.equal(report.repository, "../..");
  assert.deepEqual(report.diagnostics, []);
  assert.deepEqual(statuses(report), {
    ".cage/config.json": "created",
    "../../.claude/settings.json": "created",
    "../../CLAUDE.md": "created",
    "../../.claude/skills/cage-design/SKILL.md": "created",
    "../../.claude/skills/cage-review/SKILL.md": "created",
    "../../.codex/config.toml": "created",
    "../../AGENTS.md": "created",
    "../../.agents/skills/cage-design/SKILL.md": "created",
    "../../.agents/skills/cage-review/SKILL.md": "created",
  });
  assert.equal(JSON.parse(readFile(root, ".cage/config.json")).testAdapter, "node:test");
  assert.equal(settings(repo).hooks.Stop[0].hooks[0].command, '"$CLAUDE_PROJECT_DIR/apps/my api/node_modules/.bin/cage" gate --root "$CLAUDE_PROJECT_DIR/apps/my api"');
  assert.ok(readFile(repo, ".codex/config.toml").includes("command = '\"apps/my api/node_modules/.bin/cage\" gate --root \"apps/my api\"'"));
  assert.match(cli(root, "init").stdout, /init: Stop gate for claude, its files at the repository root \(\.\.\/\.\.\)\./);

  // Another project of the same repository gets its own entry; without an installed cage the hook is a guess, and says so.
  const web = init(path.join(repo, "apps/web"), "--agent", "claude");
  assert.equal(web.report.files.find((file) => file.path === "../../.claude/settings.json")?.status, "updated");
  assert.deepEqual(web.report.diagnostics.map(({ code, severity }) => ({ code, severity })), [{ code: "W_GATE_COMMAND", severity: "warning" }]);
  assert.deepEqual(
    settings(repo).hooks.Stop.map((entry: { hooks: { command: string }[] }) => entry.hooks[0].command),
    ['"$CLAUDE_PROJECT_DIR/apps/my api/node_modules/.bin/cage" gate --root "$CLAUDE_PROJECT_DIR/apps/my api"', '"$CLAUDE_PROJECT_DIR/node_modules/.bin/cage" gate --root "$CLAUDE_PROJECT_DIR/apps/web"'],
  );
  assert.equal(init(path.join(repo, "apps/web"), "--agent", "claude").report.files.find((file) => file.path === "../../.claude/settings.json")?.status, "kept");
});

test("the repository is found through a symbolic link, and a linked instructions file stays a link", (t) => {
  const repo = repository(t, { "AGENTS.md": "# Agents\n\nShared rules.\n" });
  fs.symlinkSync("AGENTS.md", path.join(repo, "CLAUDE.md"));
  const link = path.join(path.dirname(repo), `${path.basename(repo)}-link`);
  fs.symlinkSync(repo, link);
  t.after(() => fs.rmSync(link, { force: true }));

  const { report } = init(link, "--agent", "claude", "--agent", "codex");
  assert.equal(report.repository, ".");
  assert.deepEqual(
    report.files.filter((file) => !file.path.includes("/skills/")).map(({ path: file, status }) => [file, status]),
    [[".cage/config.json", "created"], [".claude/settings.json", "created"], ["CLAUDE.md", "updated"], [".codex/config.toml", "created"], ["AGENTS.md", "kept"]],
  );
  assert.ok(fs.lstatSync(path.join(repo, "CLAUDE.md")).isSymbolicLink());
  assert.ok(readFile(repo, "AGENTS.md").startsWith("# Agents\n\nShared rules.\n\n## Contract harness\n"));
  assert.ok(fs.existsSync(path.join(repo, ".claude/settings.json")));
});

test("--agent none writes the configuration only; a broken or odd settings file is a configuration error that stops the run", (t) => {
  const root = repository(t);
  const only = init(root, "--agent", "none");
  assert.deepEqual(statuses(only.report), { ".cage/config.json": "created" });
  assert.deepEqual(only.report.agents, []);
  assert.match(cli(root, "init", "--agent", "none").stdout, /no Stop gate set up/);

  for (const [text, reason] of [
    ["{ nope", /Unexpected token|JSON/],
    ['{ "hooks": "x" }', /"hooks" is not an object/],
    ['{ "hooks": { "Stop": [null] } }', /an entry of "hooks.Stop" is not an object/],
    ['{ "hooks": { "Stop": { } } }', /"hooks.Stop" is not an array/],
    ["[]", /not a JSON object/],
  ] as const) {
    writeFile(root, ".claude/settings.json", text);
    const broken = init(root);
    assert.equal(broken.code, 2, text);
    assert.deepEqual(broken.report.diagnostics.map(({ code, file }) => ({ code, file })), [{ code: "E_CONFIG", file: ".claude/settings.json" }], text);
    assert.match(broken.report.diagnostics[0].message, reason, text);
    assert.equal(readFile(root, ".claude/settings.json"), text);
    assert.deepEqual(statuses(broken.report), { ".cage/config.json": "kept" }, text);
    assert.equal(fs.existsSync(path.join(root, "CLAUDE.md")), false, text);
  }
  assert.match(cli(root, "init").stdout, /init: 1 error; what is listed above as created or updated was written before it\./);

  assert.match(cli(root, "init", "--agent", "cursor").stderr, /Unknown agent "cursor"/);
  assert.match(cli(root, "init", "--agent", "none", "--agent", "claude").stderr, /--agent none means no Stop gate/);
  assert.match(cli(root, "init", "--test-adapter", "jest").stderr, /Unknown test adapter "jest"/);
  assert.match(cli(root, "check", "--agent", "claude").stderr, /--agent and --test-adapter are options of the init command/);
  assert.match(cli(root, "init", "--config", "x.json").stderr, /--config does not apply/);
});
