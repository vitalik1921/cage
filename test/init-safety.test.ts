import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { InitReport } from "../src/init.ts";
import { cli, designProject, readFile, writeFile } from "./helpers.ts";

/**
 * A directory name with every character a shell or TOML would read as more than data, all of them valid in a path:
 * a command substitution and a backtick that would create a marker file if they ran, quotes of both kinds, a
 * variable, separators and spaces. Nothing here touches anything outside the scratch directory.
 */
const SPECIAL = `we$HOME $(touch SUBST-RAN) \`touch TICK-RAN\` "dq" it's; a&b`;
const MARKERS = ["SUBST-RAN", "TICK-RAN"];

/** A Git repository with a project in `apps/<SPECIAL>`, whose installed `cage` writes the arguments it gets, one per line. */
function specialRepository(t: TestContext): { repo: string; project: string; argsFile: string } {
  const repo = designProject(t, {}, { "package.json": JSON.stringify({ name: "r", private: true }) });
  assert.equal(spawnSync("git", ["init", "--quiet"], { cwd: repo }).status, 0);
  const project = path.join(repo, "apps", SPECIAL);
  fs.mkdirSync(project, { recursive: true });
  const argsFile = path.join(repo, "args.txt");
  writeFile(project, "node_modules/.bin/cage", `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argsFile)}\n`);
  fs.chmodSync(path.join(project, "node_modules/.bin/cage"), 0o755);
  return { repo, project, argsFile };
}

/** A TOML basic string as the generated line has it: its escapes are JSON's. */
function tomlCommand(text: string): string {
  const line = text.split("\n").find((candidate) => candidate.startsWith("command = "));
  assert.ok(line, text);
  const value = line.slice("command = ".length);
  assert.ok(value.startsWith('"') && value.endsWith('"'), `not a TOML basic string: ${value}`);
  return JSON.parse(value) as string;
}

/** Runs a hook command the way an agent's environment does: by a shell, from the repository. */
function runHook(repo: string, command: string, env: Record<string, string> = {}): void {
  const run = spawnSync("/bin/sh", ["-c", command], { cwd: repo, env: { ...process.env, ...env }, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
}

test("the generated hooks pass every path as data: no substitution runs, and the Codex config stays valid TOML", (t) => {
  if (process.platform === "win32") return t.skip("POSIX shells only");
  const { repo, project, argsFile } = specialRepository(t);
  const init = cli(project, "init", "--agent", "claude", "--agent", "codex", "--format", "json");
  assert.equal(init.code, 0, init.stderr);
  assert.deepEqual((JSON.parse(init.stdout) as InitReport).diagnostics, []);

  const settings = JSON.parse(readFile(repo, ".claude/settings.json"));
  const claude = settings.hooks.Stop[0].hooks[0].command as string;
  runHook(repo, claude, { CLAUDE_PROJECT_DIR: repo });
  assert.deepEqual(fs.readFileSync(argsFile, "utf8").split("\n").slice(0, -1), ["gate", "--root", `${repo}/apps/${SPECIAL}`]);

  fs.rmSync(argsFile);
  const codex = tomlCommand(readFile(repo, ".codex/config.toml"));
  runHook(repo, codex);
  assert.deepEqual(fs.readFileSync(argsFile, "utf8").split("\n").slice(0, -1), ["gate", "--root", `apps/${SPECIAL}`]);

  for (const marker of MARKERS) for (const where of [repo, project]) assert.equal(fs.existsSync(path.join(where, marker)), false, `${marker} in ${where}`);
  // A second run recognises both hooks as this project's gate.
  const again = JSON.parse(cli(project, "init", "--agent", "claude", "--agent", "codex", "--format", "json").stdout) as InitReport;
  assert.ok(again.files.every((file) => file.status === "kept"), JSON.stringify(again.files));
});

/** A Git repository with `cage` installed at its root. */
function repository(t: TestContext, files: Record<string, string> = {}): string {
  const root = designProject(t, {}, { "package.json": JSON.stringify({ name: "p", private: true }), "node_modules/.bin/cage": "#!/bin/sh\n", ...files });
  assert.equal(spawnSync("git", ["init", "--quiet"], { cwd: root }).status, 0);
  return root;
}
const init = (root: string, ...agents: string[]) => JSON.parse(cli(root, "init", "--format", "json", ...agents.flatMap((agent) => ["--agent", agent])).stdout) as InitReport;
const statusOf = (report: InitReport, file: string) => report.files.find((candidate) => candidate.path === file)?.status;
const stopCommands = (root: string) => (JSON.parse(readFile(root, ".claude/settings.json")).hooks.Stop as { hooks: { command: string }[] }[]).flatMap((group) => group.hooks.map((hook) => hook.command));

test("a hook that only mentions cage gate is not the gate: init adds its own beside it and says so", (t) => {
  const LEGACY = '"$CLAUDE_PROJECT_DIR/node_modules/.bin/cage" gate --root "$CLAUDE_PROJECT_DIR/."';
  for (const fake of [
    'echo cage gate --root "$CLAUDE_PROJECT_DIR/."',
    `${LEGACY} ; true`,
    `${LEGACY} && touch ran`,
    `${LEGACY} || true`,
    `${LEGACY} | tee log`,
    `${LEGACY} > log`,
    `${LEGACY} &`,
    `$(echo "$CLAUDE_PROJECT_DIR")/node_modules/.bin/cage gate --root "$CLAUDE_PROJECT_DIR/."`,
    '"$CLAUDE_PROJECT_DIR/node_modules/.bin/cage" gate --root "$CLAUDE_PROJECT_DIR/`echo .`"',
    '"$HOME/node_modules/.bin/cage" gate --root "$CLAUDE_PROJECT_DIR/."',
    '"$CLAUDE_PROJECT_DIR/node_modules/.bin/cage" gate --root "$CLAUDE_PROJECT_DIR/." --format json',
    "true # cage gate --root .",
  ]) {
    const root = repository(t, { ".claude/settings.json": JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: fake }] }] } }) });
    const report = init(root, "claude");
    assert.equal(statusOf(report, ".claude/settings.json"), "updated", fake);
    const commands = stopCommands(root);
    assert.equal(commands.length, 2, fake);
    assert.equal(commands[0], fake);
    assert.deepEqual(report.diagnostics.map(({ code }) => code), ["W_GATE_COMMAND"], fake);
    assert.match(report.diagnostics[0].message, /mentions `cage gate` but is not recognised as the gate of this project/);
    // The added gate is recognised from then on.
    assert.equal(statusOf(init(root, "claude"), ".claude/settings.json"), "kept", fake);
  }
  const codexFake = repository(t, { ".codex/config.toml": "[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = \"command\"\ncommand = 'echo cage gate --root \".\"'\n" });
  const report = init(codexFake, "codex");
  assert.equal(statusOf(report, ".codex/config.toml"), "updated");
  assert.equal(tomlCommand(readFile(codexFake, ".codex/config.toml").split("# cage:")[1]), "'node_modules/.bin/cage' gate --root '.'");
  for (const line of [`command = '"node_modules/.bin/cage" gate --root "." && touch ran'`, `command = "\\"node_modules/.bin/cage\\" gate --root \\"$(echo .)\\""`]) {
    const unsafe = repository(t, { ".codex/config.toml": `[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\n${line}\n` });
    const added = init(unsafe, "codex");
    assert.equal(statusOf(added, ".codex/config.toml"), "updated", line);
    assert.deepEqual(added.diagnostics.map(({ code }) => code), ["W_GATE_COMMAND"], line);
  }
});

test("the review's case: a gate an earlier init wrote for a path with a substitution is not taken for the gate", (t) => {
  if (process.platform === "win32") return t.skip("POSIX shells only");
  const repo = repository(t);
  const PROJECT = "apps/$(touch injected-marker)";
  fs.mkdirSync(path.join(repo, PROJECT), { recursive: true });
  // As 0.2.5 wrote it, and as the hook a stray timeout of 1 second.
  const legacy = `"$CLAUDE_PROJECT_DIR/node_modules/.bin/cage" gate --root "$CLAUDE_PROJECT_DIR/${PROJECT}"`;
  writeFile(repo, ".claude/settings.json", JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: legacy, timeout: 1 }] }] } }));
  const report = JSON.parse(cli(path.join(repo, PROJECT), "init", "--agent", "claude", "--format", "json").stdout) as InitReport;
  assert.equal(statusOf(report, "../../.claude/settings.json"), "updated");
  assert.deepEqual(report.diagnostics.map(({ code }) => code), ["W_GATE_COMMAND"]);
  const [, added] = stopCommands(repo);
  assert.equal(added, `"$CLAUDE_PROJECT_DIR"/'node_modules/.bin/cage' gate --root "$CLAUDE_PROJECT_DIR"/'${PROJECT}'`);
  // The added one runs the installed cage (a stub here) and creates nothing.
  writeFile(repo, "node_modules/.bin/cage", '#!/bin/sh\nprintf "%s\\n" "$@" > args.txt\n');
  fs.chmodSync(path.join(repo, "node_modules/.bin/cage"), 0o755);
  runHook(repo, added, { CLAUDE_PROJECT_DIR: repo });
  assert.deepEqual(fs.readFileSync(path.join(repo, "args.txt"), "utf8").split("\n").slice(0, -1), ["gate", "--root", `${repo}/${PROJECT}`]);
  assert.equal(fs.existsSync(path.join(repo, "injected-marker")), false);
});

test("a gate written by an earlier init or by hand, however it quotes, is recognised; so is one with the options of gate", (t) => {
  for (const command of [
    '"$CLAUDE_PROJECT_DIR/node_modules/.bin/cage" gate --root "$CLAUDE_PROJECT_DIR/."',
    '"$CLAUDE_PROJECT_DIR"/node_modules/.bin/cage gate --root "$CLAUDE_PROJECT_DIR"',
    "\"$CLAUDE_PROJECT_DIR\"/'node_modules/.bin/cage' gate --root \"$CLAUDE_PROJECT_DIR\"/'.' --base origin/main",
    "${CLAUDE_PROJECT_DIR}/node_modules/.bin/cage gate --root=${CLAUDE_PROJECT_DIR}",
  ]) {
    const root = repository(t, { ".claude/settings.json": JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command }] }] } }) });
    const report = init(root, "claude");
    assert.equal(statusOf(report, ".claude/settings.json"), "kept", command);
    assert.deepEqual(report.diagnostics, [], command);
  }
  const legacyCodex = repository(t, { ".codex/config.toml": "[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = \"command\"\ncommand = '\"node_modules/.bin/cage\" gate --root \".\"'\n" });
  assert.equal(statusOf(init(legacyCodex, "codex"), ".codex/config.toml"), "kept");
});

test("the rules go in once, behind a marker: a mention of cage check elsewhere does not stand in for them", (t) => {
  const root = repository(t, { "CLAUDE.md": "# Our project\n\nCI runs `cage check` on every push.\n" });
  const first = init(root, "claude");
  assert.equal(statusOf(first, "CLAUDE.md"), "updated");
  const text = readFile(root, "CLAUDE.md");
  assert.ok(text.startsWith("# Our project\n\nCI runs `cage check` on every push.\n\n<!-- cage:rules -->\n## Contract harness\n"), text);
  // Edited by the team, heading included: still the rules, still kept.
  writeFile(root, "CLAUDE.md", text.replace("## Contract harness", "## Our contract rules"));
  const edited = readFile(root, "CLAUDE.md");
  assert.equal(statusOf(init(root, "claude"), "CLAUDE.md"), "kept");
  assert.equal(readFile(root, "CLAUDE.md"), edited);

  // A file written by an earlier init has the heading and no marker: it is the rules too.
  const legacy = repository(t, { "AGENTS.md": "# Agents\n\n## Contract harness\n\nOld rules.\n" });
  assert.equal(statusOf(init(legacy, "codex"), "AGENTS.md"), "kept");
  // A new file starts with the marker.
  const fresh = repository(t);
  init(fresh, "claude");
  assert.ok(readFile(fresh, "CLAUDE.md").startsWith("<!-- cage:rules -->\n# Contract harness\n"));
});
