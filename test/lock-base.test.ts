import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { CheckReport } from "../src/check.ts";
import { LOCK_FILE } from "../src/locks.ts";
import { cli, contract, data, designFile, designProject, editFile, mdx, readFile, writeFile } from "./helpers.ts";

const QUOTA = contract("Quota", "take(account: AccountId): boolean;", "@final", "@invariant empty Порожня квота відмовляє.");
const STORE = contract("Store", "get(key: string): string | null;", "@extendable", "@invariant miss Невідомий ключ дає null.");
const ACCOUNT_ID = data("AccountId").replace(" * @data", " * @data\n * @final");

/**
 * A design project that is its own Git repository, with its locks recorded
 * and committed on `main`; `project` is where the project is in the
 * repository, for a project inside a larger one.
 */
function repository(t: TestContext, project = "."): { repo: string; root: string } {
  const root = designProject(t, { m: mdx(ACCOUNT_ID, QUOTA, STORE) });
  const repo = path.resolve(root, project === "." ? "." : path.join(...project.split("/").map(() => "..")));
  if (project !== ".") {
    // Move the project down into the repository directory that the caller named.
    const moved = path.join(root, "..", `${path.basename(root)}-repo`);
    fs.mkdirSync(path.join(moved, path.dirname(project)), { recursive: true });
    fs.renameSync(root, path.join(moved, project));
    t.after(() => fs.rmSync(moved, { recursive: true, force: true }));
    return setUp(path.join(moved, project), moved);
  }
  return setUp(root, repo);
}

function setUp(root: string, repo: string): { repo: string; root: string } {
  git(repo, "init", "--quiet", "--initial-branch=main");
  // Never let a test's git commands reach the harness's own repository.
  assert.equal(fs.realpathSync(git(repo, "rev-parse", "--show-toplevel").trim()), fs.realpathSync(repo));
  assert.equal(cli(root, "lock").code, 0);
  commit(repo, "designs and locks");
  return { repo, root };
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
const commit = (repo: string, message: string) => {
  git(repo, "add", "--all");
  git(repo, "commit", "--quiet", "--message", message);
};

function check(root: string, ...args: string[]): { code: number; report: CheckReport } {
  const { code, stdout, stderr } = cli(root, "check", "--phase", "design", "--format", "json", ...args);
  assert.equal(stderr, "");
  return { code, report: JSON.parse(stdout) };
}
const problems = (root: string, ...args: string[]) => check(root, ...args).report.diagnostics.map(({ code, message, file }) => ({ code, message, file }));
const change = (root: string, from: string, to: string) => editFile(root, designFile("m"), (s) => s.replace(from, to));
/** Takes the entry of a declaration out of the lock file, the way a lock is lifted by hand. */
const unlock = (root: string, name: string) => {
  const file = JSON.parse(readFile(root, LOCK_FILE));
  writeFile(root, LOCK_FILE, JSON.stringify({ ...file, locks: file.locks.filter((entry: { name: string }) => entry.name !== name) }));
};

test("--base compares the lock file with the one at a revision, and says so in the report", (t) => {
  const { root } = repository(t);
  const { code, report } = check(root, "--base", "main");
  assert.equal(code, 0);
  assert.equal(report.scope.lockBase, "main");
  assert.deepEqual(report.diagnostics, []);
  assert.equal(check(root).report.scope.lockBase, null);
  assert.ok(cli(root, "check", "--phase", "design", "--base", "HEAD").stdout.endsWith("(project). Locks compared with HEAD.\n"));
});

test("a lock lifted by editing the lock file passes locally and fails against the base", (t) => {
  const { root } = repository(t);
  change(root, "take(account: AccountId): boolean;", "take(account: AccountId): number;");
  unlock(root, "Quota");
  assert.equal(cli(root, "lock").code, 0);
  assert.equal(check(root).code, 0);

  const against = check(root, "--base", "main");
  assert.equal(against.code, 1);
  assert.deepEqual(against.report.diagnostics.map(({ code, message, file, contract }) => ({ code, message, file, contract })), [
    {
      code: "E_LOCK_BASE",
      message: 'Contract "Quota" of src/m is locked as `@final` on main: it must not change.\n`take` changed; it was: take(account: AccountId): boolean;',
      file: LOCK_FILE,
      contract: "Quota",
    },
  ]);

  // Gone altogether: tag and entry removed.
  change(root, " * @final\n * @invariant empty", " * @invariant empty");
  unlock(root, "Quota");
  assert.equal(check(root).code, 0);
  assert.deepEqual(problems(root, "--base", "main"), [
    { code: "E_LOCK_BASE", message: `Contract "Quota" of src/m is locked as \`@final\` on main, but its entry is gone from ${LOCK_FILE}. A lock that main has is not lifted here.`, file: LOCK_FILE },
  ]);
});

test("against the base an @extendable lock may grow and get stricter, not looser", (t) => {
  const { root } = repository(t);
  change(root, "  get(key: string): string | null;", "  get(key: string): string | null;\n  put(key: string, value: string): void;");
  change(root, " * @invariant miss Невідомий ключ дає null.", " * @invariant miss Невідомий ключ дає null.\n * @invariant trim Ключ порівнюється як є.");
  assert.equal(cli(root, "lock").code, 0);
  assert.deepEqual(problems(root, "--base", "main"), []);
  commit(root, "Store grew");

  // Stricter: an extendable declaration becomes final, keeping what was locked.
  change(root, " * @extendable", " * @final");
  unlock(root, "Store");
  assert.equal(cli(root, "lock").code, 0);
  assert.deepEqual(problems(root, "--base", "main"), []);
  commit(root, "Store is final");

  // Looser: final back to extendable, or a recorded member changed.
  change(root, " * @final\n * @invariant miss", " * @extendable\n * @invariant miss");
  unlock(root, "Store");
  assert.equal(cli(root, "lock").code, 0);
  assert.deepEqual(problems(root, "--base", "main"), [
    { code: "E_LOCK_BASE", message: 'Contract "Store" of src/m is locked as `@final` on main: it must not change.\nit is `@final` there and `@extendable` here', file: LOCK_FILE },
  ]);
  change(root, "put(key: string, value: string): void;", "put(key: string, value: string): boolean;");
  unlock(root, "Store");
  assert.equal(cli(root, "lock").code, 0);
  assert.deepEqual(problems(root, "--base", "HEAD~1").map(({ code, message }) => ({ code, message })), [
    {
      code: "E_LOCK_BASE",
      message: 'Contract "Store" of src/m is locked as `@extendable` on HEAD~1: what it has must not change; only members and invariants may be added.\n`put` changed; it was: put(key: string, value: string): void;',
    },
  ]);
});

test("a base without a lock file requires nothing; an unknown revision is an environment error", (t) => {
  const { root } = repository(t);
  fs.rmSync(path.join(root, LOCK_FILE));
  commit(root, "no lock file");
  change(root, " * @final\n * @invariant empty", " * @invariant empty");
  change(root, " * @extendable", "");
  change(root, " * @data\n * @final", " * @data");
  assert.equal(check(root, "--base", "HEAD").code, 0);

  const unknown = check(root, "--base", "origin/nowhere");
  assert.equal(unknown.code, 2);
  assert.deepEqual(unknown.report.diagnostics.map(({ code, message, file }) => ({ code, message, file })), [
    {
      code: "E_ENVIRONMENT",
      message: 'Cannot compare the locks with "origin/nowhere": it is not a commit of this repository; in CI the branch may need to be fetched first.',
      file: LOCK_FILE,
    },
  ]);
  assert.equal(unknown.report.scope.lockBase, "origin/nowhere");
});

test("a project inside a larger repository is compared by its own path", (t) => {
  const { root, repo } = repository(t, "apps/api");
  assert.notEqual(root, repo);
  assert.deepEqual(problems(root, "--base", "main"), []);
  change(root, "take(account: AccountId): boolean;", "take(account: AccountId): number;");
  unlock(root, "Quota");
  assert.equal(cli(root, "lock").code, 0);
  assert.deepEqual(problems(root, "--base", "main").map(({ code }) => code), ["E_LOCK_BASE"]);
});

test("--base is an option of check, with a revision", (t) => {
  const { root } = repository(t);
  const extract = cli(root, "extract", "--base", "main");
  assert.equal(extract.code, 2);
  assert.match(extract.stderr, /--base is an option of the check and gate commands/);
  const empty = cli(root, "check", "--base", "");
  assert.equal(empty.code, 2);
  assert.match(empty.stderr, /--base needs a Git revision/);
});
