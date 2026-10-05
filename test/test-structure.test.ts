import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { ReviewReport } from "../src/review.ts";
import { checkLinking, cli, contract, designProject, editFile, mdx, PROJECT_OPTIONS, VITEST } from "./helpers.ts";

// The follow-up to the independent review of the audit fixes: hooks are found by their binding to the
// runner, wherever and however they are written, and become part of the material of the tests they set up;
// a callback named in the same file is read for emptiness; and one inactive test linked to an invariant
// without any active test and to one with an active test is reported for each, separately.

const QUOTA = contract("Quota", "take(): boolean;", "@invariant empty An empty quota refuses.", "@invariant consume A take uses one send.", "@invariant race Takes never overlap.");
const IMPLEMENTATION = "/** @implements Quota */\nexport const quota = { take: (): boolean => true };\n";
const TEST_FILE = "src/m/quota.test.ts";
const lines = (...text: string[]) => `${text.join("\n")}\n`;
type Adapter = "node:test" | "vitest";

function project(t: TestContext, adapter: Adapter, tests: string, extra: Record<string, string> = {}): string {
  return designProject(
    t,
    { m: mdx(QUOTA) },
    {
      "src/m/quota.ts": IMPLEMENTATION,
      [TEST_FILE]: tests,
      ".cage/config.json": JSON.stringify({ version: 1, testAdapter: adapter, coverage: "off" }),
      ...(adapter === "vitest" ? VITEST : {}),
      ...extra,
    },
  );
}

const declarations = (root: string, adapter: Adapter) => checkLinking(root, adapter).linking.tests;
/** Each test's setup, as the lines of the hooks in effect for it. */
const setupLines = (root: string, adapter: Adapter) => Object.fromEntries(declarations(root, adapter).map((test) => [test.title, test.setup.map((hook) => hook.line)]));
const statuses = (root: string, adapter: Adapter) => Object.fromEntries(declarations(root, adapter).map((test) => [test.title, test.status]));
const lineOf = (text: string, needle: string) => text.split("\n").findIndex((line) => line.includes(needle)) + 1;

function fingerprint(root: string): string {
  const report = JSON.parse(cli(root, "review", "--all", "--format", "json").stdout) as ReviewReport;
  return report.contracts.find((entry) => entry.contract === "Quota")!.fingerprint;
}

/** Whether replacing `from` by `to` in the test file changes the fingerprint of Quota's review; the edit is undone after. */
function changesFingerprint(root: string, from: string, to: string): boolean {
  const before = fingerprint(root);
  editFile(root, TEST_FILE, (text) => {
    assert.ok(text.includes(from), from);
    return text.replace(from, to);
  });
  const after = fingerprint(root);
  editFile(root, TEST_FILE, (text) => text.replace(to, from));
  return before !== after;
}

const NODE_HOOKS = lines(
  'import assert from "node:assert/strict";',
  'import { describe, it, beforeEach as setup } from "node:test";',
  'import * as runner from "node:test";',
  'import test from "node:test";',
  "",
  "let ready = false;",
  "const log: string[] = [];",
  "// A local function that merely has a hook's name registers nothing with the runner.",
  "function beforeEach(fn: () => void): void { fn(); }",
  "setup(() => { ready = true; });",
  'beforeEach(() => { log.push("not a hook"); });',
  "",
  "/** @tests Quota */",
  'describe("Quota", () => {',
  '  runner.beforeEach(() => { log.push("namespace"); });',
  "  /** @covers empty consume race */",
  '  it("top", () => { assert.ok(ready); });',
  '  describe("inner", () => {',
  "    test.afterEach(() => { log.length = 0; });",
  "    /** @covers empty */",
  '    it("nested", () => { assert.ok(ready); });',
  "  });",
  "});",
);

test("node:test hooks are found by their binding — aliased, namespaced, on the default export, at the root and in suites — and set up the tests in scope", (t) => {
  const root = project(t, "node:test", NODE_HOOKS);
  const at = (needle: string) => lineOf(NODE_HOOKS, needle);
  assert.deepEqual(setupLines(root, "node:test"), {
    top: [at("setup(() =>"), at("runner.beforeEach")],
    nested: [at("setup(() =>"), at("runner.beforeEach"), at("test.afterEach")],
  });
  // An edit of nothing but a hook's body changes the material of the tests it sets up.
  assert.equal(changesFingerprint(root, "ready = true;", "ready = !false;"), true, "root hook, aliased");
  assert.equal(changesFingerprint(root, 'log.push("namespace")', 'log.push("namespace, changed")'), true, "suite hook, namespaced");
  assert.equal(changesFingerprint(root, "log.length = 0;", "log.splice(0);"), true, "nested suite hook, on the default export");
  // A call of a function merely named like a hook is not setup.
  assert.equal(changesFingerprint(root, 'log.push("not a hook")', 'log.push("still not a hook")'), false);
});

const VITEST_HOOKS = lines(
  'import { describe, it, expect, beforeEach as setup, beforeAll } from "vitest";',
  'import * as v from "vitest";',
  "",
  "let ready = false;",
  "let count = 0;",
  "function afterEach(fn: () => void): void { fn(); }",
  "setup(() => { ready = true; });",
  "beforeAll(() => { count = 1; });",
  "afterEach(() => { count = 99; });",
  "",
  "/** @tests Quota */",
  'describe("Quota", () => {',
  "  v.beforeEach(() => { count += 1; });",
  "  /** @covers empty consume race */",
  '  it("top", () => { expect(ready).toBe(true); });',
  '  describe("inner", () => {',
  "    v.afterAll(() => { count = 0; });",
  "    /** @covers empty */",
  '    it("nested", () => { expect(count).toBe(2); });',
  "  });",
  "});",
);

test("Vitest hooks are found by their binding — aliased, namespaced, at the root and in suites — and set up the tests in scope", (t) => {
  const root = project(t, "vitest", VITEST_HOOKS);
  const at = (needle: string) => lineOf(VITEST_HOOKS, needle);
  assert.deepEqual(setupLines(root, "vitest"), {
    top: [at("setup(() =>"), at("beforeAll("), at("v.beforeEach")],
    nested: [at("setup(() =>"), at("beforeAll("), at("v.beforeEach"), at("v.afterAll")],
  });
  assert.equal(changesFingerprint(root, "ready = true;", "ready = !false;"), true, "root hook, aliased");
  assert.equal(changesFingerprint(root, "count = 1;", "count = 2;"), true, "root hook, by its own name");
  assert.equal(changesFingerprint(root, "count += 1;", "count += 2;"), true, "suite hook, namespaced");
  assert.equal(changesFingerprint(root, "count = 0;", "count = -1;"), true, "nested suite hook");
  assert.equal(changesFingerprint(root, "count = 99;", "count = 98;"), false, "a local function named afterEach");
});

test("Vitest global hooks count when the project loads Vitest's globals, and only then", (t) => {
  const tests = lines(
    "let ready = false;",
    "beforeEach(() => { ready = true; });",
    "/** @tests Quota */",
    'describe("Quota", () => {',
    "  afterAll(() => { ready = false; });",
    "  /** @covers empty consume race */",
    '  it("all", () => { expect(ready).toBe(true); });',
    "});",
  );
  const withGlobals = project(t, "vitest", tests, { "tsconfig.json": JSON.stringify({ compilerOptions: { ...PROJECT_OPTIONS, types: ["vitest/globals"] } }) });
  assert.deepEqual(setupLines(withGlobals, "vitest"), { all: [lineOf(tests, "beforeEach("), lineOf(tests, "afterAll(")] });
  assert.equal(changesFingerprint(withGlobals, "ready = true;", "ready = !false;"), true);
});

test("a callback named in the same file is read for emptiness: functions, consts, trivial aliases and object properties; imports, lets and cycles stay active", (t) => {
  const tests = lines(
    'import assert from "node:assert/strict";',
    'import { describe, it } from "node:test";',
    'import { importedEmpty } from "./callbacks.ts";',
    "",
    "const empty = () => {};",
    "function emptyDeclared(): void {}",
    "const full = () => { assert.ok(true); };",
    "const alias = empty;",
    "const aliasOfAlias = alias;",
    "const cases = { blank: () => {}, filled() { assert.ok(true); }, empty, nested: { deeper: alias } };",
    "let mutable = () => {};",
    "const loopA: () => void = loopB;",
    "const loopB: () => void = loopA;",
    "",
    "/** @tests Quota */",
    'describe("Quota", () => {',
    "  /** @covers empty */",
    '  it("named empty", empty);',
    "  /** @covers empty */",
    '  it("declared empty", emptyDeclared);',
    "  /** @covers empty consume race */",
    '  it("named full", full);',
    "  /** @covers empty */",
    '  it("alias of an alias", aliasOfAlias);',
    "  /** @covers empty */",
    '  it("property", cases.blank);',
    "  /** @covers empty */",
    '  it("method with a body", cases.filled);',
    "  /** @covers empty */",
    '  it("shorthand property", cases.empty);',
    "  /** @covers empty */",
    '  it("nested property", cases.nested.deeper);',
    "  /** @covers empty */",
    '  it("let", mutable);',
    "  /** @covers empty */",
    '  it("imported", importedEmpty);',
    "  /** @covers empty */",
    '  it("cycle", loopA);',
    "});",
  );
  const root = project(t, "node:test", tests, { "src/m/callbacks.ts": "export const importedEmpty = (): void => {};\n" });
  assert.deepEqual(statuses(root, "node:test"), {
    "named empty": "empty",
    "declared empty": "empty",
    "named full": "active",
    "alias of an alias": "empty",
    property: "empty",
    "method with a body": "active",
    "shorthand property": "empty",
    "nested property": "empty",
    // Not followed: a `let` may be reassigned, an import is code this file does not show, a cycle leads nowhere.
    let: "active",
    imported: "active",
    cycle: "active",
  });
  const named = declarations(root, "node:test").find((declaration) => declaration.title === "alias of an alias")!;
  assert.equal(named.inactiveBecause, `has an empty body (\`aliasOfAlias\`, line ${lineOf(tests, "const empty =")})`);
});

test("Vitest: a named empty callback is empty, a named one with a body is active, and an alias cycle stops", (t) => {
  const tests = lines(
    'import { describe, it, expect } from "vitest";',
    "const blank = () => {};",
    "const check = () => { expect(1).toBe(1); };",
    "const helpers = { blank, check };",
    "const ring: () => void = round;",
    "const round: () => void = ring;",
    "/** @tests Quota */",
    'describe("Quota", () => {',
    "  /** @covers empty consume race */",
    '  it("with a body", helpers.check);',
    "  /** @covers empty */",
    '  it("blank", helpers.blank);',
    "  /** @covers empty */",
    '  it("ring", ring);',
    "});",
  );
  const root = project(t, "vitest", tests);
  assert.deepEqual(statuses(root, "vitest"), { "with a body": "active", blank: "empty", ring: "active" });
});

for (const adapter of ["node:test", "vitest"] as const) {
  test(`${adapter}: one inactive test linked to an invariant with no active test and to one with an active test is an error for the first and a warning for the second`, (t) => {
    const runner = adapter === "vitest" ? 'import { describe, it, expect } from "vitest";' : 'import { describe, it } from "node:test";\nimport assert from "node:assert/strict";';
    const assertion = adapter === "vitest" ? "expect(1).toBe(1);" : "assert.ok(true);";
    const root = project(
      t,
      adapter,
      lines(
        runner,
        "/** @tests Quota */",
        'describe("Quota", () => {',
        "  /** @covers empty consume */",
        `  it.skip("skipped", () => { ${assertion} });`,
        "  /** @covers consume race */",
        `  it("active", () => { ${assertion} });`,
        "});",
      ),
    );
    const { errors, warnings } = checkLinking(root, adapter);
    assert.deepEqual(errors.map(({ code, invariant }) => ({ code, invariant })), [{ code: "E_TEST_INACTIVE", invariant: "empty" }]);
    assert.deepEqual(
      warnings.filter(({ code }) => code === "W_TEST_INACTIVE").map(({ message }) => message.replace(/ \(src\/m\/quota\.test\.ts:\d+, /, " (…, ")),
      ['"Quota > skipped" skipped by `.skip`; covers Quota.consume'],
    );
  });
}

test("node:test: the callback is the callable argument, after named options too; options alone are no callback; an import stays unknown", (t) => {
  const tests = lines(
    'import assert from "node:assert/strict";',
    'import { describe, it } from "node:test";',
    'import { importedEmpty } from "./callbacks.ts";',
    "const options = { timeout: 10 };",
    "const title = \"computed\";",
    "const empty = () => {};",
    "const full = () => { assert.ok(true); };",
    "const alias = empty;",
    "const cases = { blank: () => {} };",
    "let later = () => {};",
    "/** @tests Quota */",
    'describe("Quota", () => {',
    "  /** @covers empty */",
    '  it("options, named empty", options, empty);',
    "  /** @covers empty consume race */",
    '  it("options, named full", options, full);',
    "  /** @covers empty */",
    '  it("options, alias", options, alias);',
    "  /** @covers empty */",
    '  it("options, property", options, cases.blank);',
    "  /** @covers empty */",
    '  it("options alone", options);',
    "  /** @covers empty */",
    '  it("options, imported", options, importedEmpty);',
    "  /** @covers empty */",
    '  it("options, let", options, later);',
    "  /** @covers empty */",
    "  it(title, { timeout: 5 }, empty);",
    "  /** @covers empty */",
    '  it("options, inline empty", options, () => {});',
    "  /** @covers empty */",
    '  it.skip("skipped, options, full", options, full);',
    "});",
  );
  const root = project(t, "node:test", tests, { "src/m/callbacks.ts": "export const importedEmpty = (): void => {};\n" });
  assert.deepEqual(
    declarations(root, "node:test").map(({ title, status }) => `${title || "(computed title)"}: ${status}`),
    [
      "options, named empty: empty",
      "options, named full: active",
      "options, alias: empty",
      "options, property: empty",
      "options alone: empty",
      // The file does not show these bodies: unknown, so active.
      "options, imported: active",
      "options, let: active",
      "(computed title): empty",
      "options, inline empty: empty",
      "skipped, options, full: skipped",
    ],
  );
  const reasons = Object.fromEntries(declarations(root, "node:test").map((test) => [test.title, test.inactiveBecause]));
  assert.equal(reasons["options, named empty"], `has an empty body (\`empty\`, line ${lineOf(tests, "const empty =")})`);
  assert.equal(reasons["options alone"], "has no callback");
});

test("Vitest: the callback is found before a timeout and after options; options alone are no callback; an import stays unknown", (t) => {
  const tests = lines(
    'import { describe, it, expect } from "vitest";',
    'import { importedEmpty } from "./callbacks.ts";',
    "const options = { retry: 2 };",
    "const timeout = 1000;",
    "const blank = () => {};",
    "const check = () => { expect(1).toBe(1); };",
    "/** @tests Quota */",
    'describe("Quota", () => {',
    "  /** @covers empty */",
    '  it("named empty, timeout", blank, timeout);',
    "  /** @covers empty consume race */",
    '  it("named full, timeout", check, 1000);',
    "  /** @covers empty */",
    '  it("options, named empty", options, blank);',
    "  /** @covers empty */",
    '  it("options, named full", options, check);',
    "  /** @covers empty */",
    '  it("options alone", options);',
    "  /** @covers empty */",
    '  it("options, imported", options, importedEmpty);',
    "});",
  );
  const root = project(t, "vitest", tests, { "src/m/callbacks.ts": "export const importedEmpty = (): void => {};\n" });
  assert.deepEqual(statuses(root, "vitest"), {
    "named empty, timeout": "empty",
    "named full, timeout": "active",
    "options, named empty": "empty",
    "options, named full": "active",
    "options alone": "empty",
    "options, imported": "active",
  });
});
