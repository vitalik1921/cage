import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { checkLinking, contract, designProject, inFile, located, mdx, PROJECT_OPTIONS } from "./helpers.ts";

const QUOTA = contract("Quota", "take(): boolean;", "@invariant empty Порожня квота відмовляє.", "@invariant consume Списує одиницю.", "@invariant race Не перевищує залишок.");
const IMPLEMENTATION = "/** @implements Quota */\nexport const quota = { take: () => true };\n";
const TEST_FILE = "src/m/quota.test.ts";

/** The part of Vitest's type definitions that the adapter looks at: what is exported, and what the globals are. */
const VITEST = {
  "node_modules/vitest/package.json": JSON.stringify({
    name: "vitest",
    version: "4.0.0",
    type: "module",
    exports: { ".": { types: "./index.d.ts" }, "./globals": { types: "./globals.d.ts" } },
  }),
  "node_modules/vitest/index.d.ts": [
    "type Declare = (title: unknown, ...rest: unknown[]) => void;",
    "type Chain = Declare & { [modifier in 'skip' | 'only' | 'todo' | 'concurrent' | 'sequential' | 'fails' | 'shuffle']: Chain } & {",
    "  each: (cases: readonly unknown[]) => Declare;",
    "  skipIf: (condition: unknown) => Chain;",
    "};",
    "export declare const describe: Chain;",
    "export declare const suite: Chain;",
    "export declare const it: Chain;",
    "export declare const test: Chain;",
    "export declare const expect: (value: unknown) => { toBe(expected: unknown): void };",
    "",
  ].join("\n"),
  "node_modules/vitest/globals.d.ts": [
    "declare global {",
    "  let suite: typeof import('vitest')['suite']",
    "  let test: typeof import('vitest')['test']",
    "  let describe: typeof import('vitest')['describe']",
    "  let it: typeof import('vitest')['it']",
    "  let expect: typeof import('vitest')['expect']",
    "}",
    "export {}",
    "",
  ].join("\n"),
};

const lines = (...text: string[]) => `${text.join("\n")}\n`;

function project(t: TestContext, tests: string, extra: Record<string, string> = {}): string {
  return designProject(t, { m: mdx(QUOTA) }, { "src/m/quota.ts": IMPLEMENTATION, ...VITEST, [TEST_FILE]: tests, ...extra });
}

const check = (root: string) => checkLinking(root, "vitest");
const links = (root: string) => check(root).linking.tests.map(({ title, suitePath, contract, covers, adapter }) => `${adapter}: ${[...suitePath, title].join(" > ")} [${contract}: ${covers.join(" ")}]`);
const position = (root: string, needle: string) => {
  const { line, column } = inFile(root, TEST_FILE, needle);
  return { line, column };
};

test("Vitest declarations are recognised by their import from vitest", (t) => {
  const root = project(
    t,
    lines(
      'import { describe, it as check, test, suite, expect } from "vitest";',
      'import * as runner from "vitest";',
      "",
      "/** @tests Quota */",
      'describe("Quota", () => {',
      "  /** @covers empty */",
      '  check("alias", () => {',
      "    expect(1).toBe(1);",
      "  });",
      "  /** @covers consume */",
      '  test.concurrent.skip("chained modifiers", () => {});',
      "",
      '  suite("inner", { retry: 2 }, () => {',
      "    /** @covers race */",
      '    runner.it.fails("namespace, with a timeout after the callback", () => {}, 1000);',
      "    /** @covers empty */",
      '    check.todo("to do");',
      "  });",
      "});",
    ),
  );
  assert.deepEqual(check(root).errors, []);
  assert.deepEqual(links(root), [
    "vitest: Quota > alias [Quota: empty]",
    "vitest: Quota > chained modifiers [Quota: consume]",
    "vitest: Quota > inner > namespace, with a timeout after the callback [Quota: race]",
    "vitest: Quota > inner > to do [Quota: empty]",
  ]);
});

test("Vitest globals are recognised when the project loads their types, and only then", (t) => {
  const tests = lines("/** @tests Quota */", 'describe.sequential("Quota", () => {', "  /** @covers empty consume race */", '  it("all", () => {});', "});");
  const withGlobals = project(t, tests, { "tsconfig.json": JSON.stringify({ compilerOptions: { ...PROJECT_OPTIONS, types: ["vitest/globals"] } }) });
  assert.deepEqual(check(withGlobals).errors, []);
  assert.deepEqual(links(withGlobals), ["vitest: Quota > all [Quota: empty consume race]"]);

  // Without the types nothing says that `describe` is Vitest's: a name alone is not a declaration.
  const without = project(t, tests);
  assert.deepEqual(
    check(without).errors.map(located),
    [
      { code: "E_TAG_LOCATION", file: TEST_FILE, ...position(without, "@tests Quota") },
      { code: "E_TAG_LOCATION", file: TEST_FILE, ...position(without, "@covers empty consume race") },
    ],
  );
});

test("each adapter reads only its own runner", (t) => {
  const vitestFile = lines('import { describe, it } from "vitest";', "/** @tests Quota */", 'describe("Quota", () => {', "  /** @covers empty consume race */", '  it("all", () => {});', "});");
  const nodeFile = vitestFile.replace('"vitest"', '"node:test"');

  const vitestProject = project(t, vitestFile);
  assert.deepEqual(checkLinking(vitestProject, "vitest").errors, []);
  assert.ok(checkLinking(vitestProject, "node:test").errors.some((error) => error.code === "E_TAG_LOCATION"));

  const nodeProject = project(t, nodeFile);
  assert.deepEqual(checkLinking(nodeProject, "node:test").errors, []);
  assert.ok(checkLinking(nodeProject, "vitest").errors.some((error) => error.code === "E_TAG_LOCATION"));
});

test("it.each declares one test with its template title; forms that decide at run time do not", (t) => {
  const root = project(
    t,
    lines(
      'import vitest, { describe, it } from "vitest";',
      "",
      "/** @tests Quota */",
      'describe("Quota", () => {',
      "  /** @covers empty consume race */",
      '  it("all", () => {});',
      "",
      "  /** @covers empty */",
      '  it.each([1, 2])("a table of cases", () => {});',
      "",
      "  /** @covers consume */",
      '  it.skipIf(process.env.CI)("conditional", () => {});',
      "",
      "  /** @covers race */",
      '  vitest("the default export is not a test function", () => {});',
      "});",
    ),
  );
  assert.deepEqual(check(root).errors.map(located), [
    { code: "E_TAG_LOCATION", file: TEST_FILE, ...position(root, "@covers consume */") },
    { code: "E_TAG_LOCATION", file: TEST_FILE, ...position(root, "@covers race */") },
  ]);
  assert.match(check(root).errors[0].message, /right before an it\/test call of vitest/);
  assert.ok(check(root).linking.tests.some((test) => test.title === "a table of cases" && test.covers.includes("empty")));
});
