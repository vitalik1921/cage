import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { cli, copyFixture, fixturesDir, snapshot } from "./helpers.ts";

const entry = path.join(import.meta.dirname, "../src/cli.ts");
const vertical = path.join(fixturesDir, "vertical");

/** Runs the real entry point in a child process. */
function spawnCli(cwd: string, ...args: string[]) {
  const { status, stdout, stderr } = spawnSync(process.execPath, [entry, ...args], { cwd, encoding: "utf8" });
  return { code: status, stdout, stderr };
}

test("--help and --version print to stdout and exit 0", () => {
  const help = spawnCli(vertical, "--help");
  assert.equal(help.code, 0);
  assert.match(help.stdout, /^Usage: cage <command> \[options\]/);
  assert.equal(help.stderr, "");

  const version = spawnCli(vertical, "--version");
  const manifest = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "../package.json"), "utf8"));
  assert.deepEqual(version, { code: 0, stdout: `${manifest.version}\n`, stderr: "" });
});

/** @tests Cli
 * @covers exit-codes */
test("invalid arguments exit 2 with a message on stderr and nothing on stdout", () => {
  const cases: [string[], RegExp][] = [
    [[], /Missing command/],
    [["frobnicate"], /Unknown command "frobnicate"/],
    [["check", "--phase", "review"], /Unknown phase "review"/],
    [["check", "--phase", "design", "--check"], /Unknown option '--check'/],
    [["inspect"], /Unknown command "inspect"/],
    [["extract"], /Unknown command "extract"/],
    [["check", "extra"], /Unexpected argument "extra"/],
    [["check", "--fix"], /Unknown option '--fix'/],
    [["lock", "--phase", "design"], /--phase is an option of the check command/],
    [["check", "--format", "xml"], /Unknown format "xml"/],
    [["check", "--format"], /--format/],
    [["check", "--root", "no/such/dir"], /is not a directory/],
  ];
  for (const [args, message] of cases) {
    const result = cli(vertical, ...args);
    assert.equal(result.code, 2, args.join(" "));
    assert.equal(result.stdout, "", args.join(" "));
    assert.match(result.stderr, message, args.join(" "));
  }
});

test("a file system failure during discovery is exit 2 and names the path", { skip: process.getuid?.() === 0 }, (t) => {
  const root = copyFixture(t, "vertical");
  const locked = path.join(root, "src/modules/locked");
  fs.mkdirSync(locked, { mode: 0o000 });
  try {
    const result = cli(root, "check");
    assert.equal(result.code, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^cage: EACCES: permission denied, scandir '.*src\/modules\/locked'\n$/);
  } finally {
    fs.chmodSync(locked, 0o700);
  }
});

test("the entry point reports through stdout and the exit code only", (t) => {
  const root = copyFixture(t, "vertical");
  const before = snapshot(root);

  // --root is resolved against the working directory; the report stays relative to the root.
  const check = spawnCli(path.dirname(root), "check", "--phase", "design", "--format", "json", "--root", path.basename(root));
  assert.equal(check.code, 0);
  assert.equal(check.stderr, "");
  const report = JSON.parse(check.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.scope.designFiles[0], "src/modules/campaigns/campaigns.cage.mdx");
  assert.deepEqual(snapshot(root), before);

  // Reports are deterministic: no timestamps, no run identifiers.
  const first = spawnCli(root, "check", "--format", "json");
  const second = spawnCli(root, "check", "--format", "json");
  assert.equal(first.code, 0);
  assert.equal(second.stdout, first.stdout);
});
