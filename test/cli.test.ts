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
  assert.match(help.stdout, /^Usage: design <command> \[options\]/);
  assert.equal(help.stderr, "");

  const version = spawnCli(vertical, "--version");
  const manifest = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "../package.json"), "utf8"));
  assert.deepEqual(version, { code: 0, stdout: `${manifest.version}\n`, stderr: "" });
});

test("invalid arguments exit 2 with a message on stderr and nothing on stdout", () => {
  const cases: [string[], RegExp][] = [
    [[], /Missing command/],
    [["frobnicate"], /Unknown command "frobnicate"/],
    [["check"], /implementation phase is not available yet/],
    [["check", "--phase", "implementation"], /implementation phase is not available yet/],
    [["check", "--phase", "review"], /Unknown phase "review"/],
    [["check", "--phase", "design", "--check"], /--check is an option of the extract command/],
    [["inspect"], /Unknown command "inspect"/],
    [["extract", "extra"], /Unexpected argument "extra"/],
    [["extract", "--fix"], /Unknown option '--fix'/],
    [["extract", "--phase", "design"], /--phase is an option of the check command/],
    [["extract", "--format", "xml"], /Unknown format "xml"/],
    [["extract", "--format"], /--format/],
    [["extract", "--check=yes"], /--check/],
    [["extract", "--root", "no/such/dir"], /is not a directory/],
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
    const result = cli(root, "extract");
    assert.equal(result.code, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^design: EACCES: permission denied, scandir '.*src\/modules\/locked'\n$/);
  } finally {
    fs.chmodSync(locked, 0o700);
  }
});

test("the entry point reports through stdout and the exit code only", (t) => {
  const root = copyFixture(t, "vertical");
  const before = snapshot(root);

  // --root is resolved against the working directory; the report stays relative to the root.
  const check = spawnCli(path.dirname(root), "extract", "--check", "--format", "json", "--root", path.basename(root));
  assert.equal(check.code, 1);
  assert.equal(check.stderr, "");
  const report = JSON.parse(check.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.outputs[0].path, "src/modules/campaigns/.design/design.generated.ts");
  assert.deepEqual(snapshot(root), before);

  const extract = spawnCli(root, "extract", "--format", "json");
  assert.equal(extract.code, 0);
  assert.equal(extract.stderr, "");
  assert.equal(JSON.parse(extract.stdout).ok, true);

  // Reports are deterministic: no timestamps, no run identifiers.
  const first = spawnCli(root, "extract", "--check", "--format", "json");
  const second = spawnCli(root, "extract", "--check", "--format", "json");
  assert.equal(first.code, 0);
  assert.equal(second.stdout, first.stdout);
});
