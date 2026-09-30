import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { IGNORE_FILE, ownerOf, readModuleScopes } from "../src/coverage.ts";
import { checkDesigns, checkLinking, cli, contract, designProject, inFile, mdx, writeFile } from "./helpers.ts";

const STORE = contract("Store", "get(key: string): string;", "@invariant hit Повертає значення.");
const IMPLEMENTATION = "/** @implements Store */\nexport class MemoryStore {\n  get(key: string): string {\n    return key;\n  }\n}\n";
const TESTS = ['import { describe, it } from "node:test";', "/** @tests Store */", 'describe("Store", () => {', "  /** @covers hit */", '  it("hit", () => {});', "});", ""].join("\n");

/** A module `src/m` with the Store contract, its implementation and test, and the given extra files. */
function project(t: TestContext, files: Record<string, string>, designs: Record<string, string> = {}): string {
  return designProject(t, { m: mdx(STORE), ...designs }, { "src/m/memory-store.ts": IMPLEMENTATION, "src/m/store.test.ts": TESTS, ...files });
}

const uncovered = (root: string) =>
  checkLinking(root)
    .diagnostics.filter((diagnostic) => diagnostic.code === "W_NOT_DESIGNED")
    .map(({ severity, message, file, line, column }) => ({ severity, what: /^Exported (\w+ "[^"]+")/.exec(message)?.[1], file, line, column }));

test("exported code of a module that its design does not cover is a warning", (t) => {
  const root = project(t, {
    "src/m/controller.ts": [
      "export class Controller {}",
      "export function handle(): void {}",
      "export const limit = 10, retries = 3;",
      "export const helper = (): void => {};",
      "",
      "// None of these is code that a contract could describe, or it is not exported.",
      "class Internal {}",
      "function internal(): void {}",
      "export default class {}",
      "export declare function ambient(): void;",
      "export interface Shape { a: string }",
      "export type Alias = string;",
      "export enum Mode { A }",
      'export type { Other } from "./other.ts";',
      "void Internal; void internal;",
      "",
    ].join("\n"),
    "src/m/other.ts": "export type Other = string;\n",
    "src/m/deep/nested/worker.ts": "export class Worker {}\n",
    // Outside every module with a design, and in a test file: nobody expects a design here.
    "src/elsewhere/free.ts": "export class Free {}\n",
    "src/m/helpers.test.ts": "export class TestHelper {}\n",
  });
  const { diagnostics, errors } = checkLinking(root);
  assert.deepEqual(errors, []);
  assert.deepEqual(uncovered(root), [
    { severity: "warning", what: 'class "Controller"', ...inFile(root, "src/m/controller.ts", "Controller") },
    { severity: "warning", what: 'function "handle"', ...inFile(root, "src/m/controller.ts", "handle") },
    { severity: "warning", what: 'const "limit"', ...inFile(root, "src/m/controller.ts", "limit") },
    { severity: "warning", what: 'const "retries"', ...inFile(root, "src/m/controller.ts", "retries") },
    { severity: "warning", what: 'const "helper"', ...inFile(root, "src/m/controller.ts", "helper") },
    { severity: "warning", what: 'class "Worker"', ...inFile(root, "src/m/deep/nested/worker.ts", "Worker") },
  ]);
  assert.equal(
    diagnostics.find((diagnostic) => diagnostic.code === "W_NOT_DESIGNED")?.message,
    'Exported class "Controller" is not covered by the design of src/m: nothing marks it `@implements`. Describe its contract in the design, or list the file in src/m/.cage/ignore.',
  );
  // Warnings do not fail the check, and the design phase does not look at code at all.
  assert.equal(cli(root, "check").code, 0);
  assert.deepEqual(checkDesigns(root).diagnostics, []);
});

test("a module's ignore file lists the files and folders that need no design", (t) => {
  const root = project(t, {
    "src/m/entities/account.ts": "export const accounts = {};\n",
    "src/m/sub/entities/deep.ts": "export const deep = {};\n",
    "src/m/m.module.ts": "export class Module {}\n",
    "src/m/sub/sub.module.ts": "export class SubModule {}\n",
    "src/m/dto/request/upsert.ts": "export const Upsert = {};\n",
    "src/m/dto/response/view.ts": "export const View = {};\n",
    "src/m/generated/client.ts": "export class Client {}\n",
    "src/m/sub/generated/client.ts": "export class SubClient {}\n",
    "src/m/controller.ts": "export class Controller {}\n",
  });
  assert.equal(uncovered(root).length, 9);

  writeFile(
    root,
    `src/m/${IGNORE_FILE}`,
    [
      "# Database tables and NestJS wiring carry no behaviour of their own.",
      "entities/",
      "*.module.ts",
      "",
      "dto/request/upsert.ts",
      "/generated",
    ].join("\n"),
  );
  assert.deepEqual(uncovered(root).map(({ what, file }) => [what, file]), [
    ['class "Controller"', "src/m/controller.ts"],
    ['const "View"', "src/m/dto/response/view.ts"],
    // `/generated` is a path from the module root: the folder of the same name further down is not it.
    ['class "SubClient"', "src/m/sub/generated/client.ts"],
  ]);

  // An ignored file is not skipped altogether: its tags are still read.
  writeFile(root, "src/m/entities/account.ts", "/** @implements Nope */\nexport const accounts = {};\n");
  assert.deepEqual(checkLinking(root).errors.map(({ code, file }) => ({ code, file })), [{ code: "E_REFERENCE_UNKNOWN", file: "src/m/entities/account.ts" }]);
});

test("a file belongs to the nearest module above it", (t) => {
  const inner = contract("Inner", "run(): void;", "@invariant ok Працює.");
  const root = project(
    t,
    {
      "src/m/outer.ts": "export class Outer {}\n",
      "src/m/inner/inner.ts": "/** @implements Inner */\nexport class InnerImpl {\n  run(): void {}\n}\nexport class Extra {}\n",
      "src/m/inner/inner.test.ts": TESTS.replace("Store", "Inner").replace('"Store"', '"Inner"').replace("hit", "ok").replace('"hit"', '"ok"'),
      "src/m/inner/skipped.ts": "export class Skipped {}\n",
      // The outer module ignores everything; that says nothing about the module inside it.
      [`src/m/${IGNORE_FILE}`]: "*.ts\ninner/\n",
      [`src/m/inner/${IGNORE_FILE}`]: "skipped.ts\n",
    },
    { "m/inner": mdx(inner) },
  );
  assert.deepEqual(checkLinking(root).errors, []);
  assert.deepEqual(uncovered(root).map(({ what, file }) => [what, file]), [['class "Extra"', "src/m/inner/inner.ts"]]);
});

test("a declaration with a rejected @implements is an error, not also uncovered", (t) => {
  const root = project(t, { "src/m/other.ts": "/** @implements Stor */\nexport class Typo {}\n" });
  const { diagnostics } = checkLinking(root);
  assert.deepEqual(diagnostics.map(({ code, file }) => ({ code, file })), [{ code: "E_REFERENCE_UNKNOWN", file: "src/m/other.ts" }]);
});

test("ignore patterns are read like a .gitignore, without negation", (t) => {
  const patterns = ["# comment", "", "  entities/  ", "!entities/keep.ts", ""];
  const root = project(t, { [`src/m/${IGNORE_FILE}`]: patterns.join("\n") });
  const { scopes, diagnostics } = readModuleScopes(root, ["src/m", "src"]);
  assert.deepEqual(diagnostics, [
    {
      code: "E_CONFIG",
      severity: "error",
      message: "Negated patterns (`!`) are not supported in an ignore file.",
      file: `src/m/${IGNORE_FILE}`,
      line: patterns.indexOf("!entities/keep.ts") + 1,
      column: 1,
    },
  ]);
  const [module, parent] = scopes;
  assert.equal(module.ignores("src/m/entities/a.ts"), true);
  assert.equal(module.ignores("src/m/x/entities/y/a.ts"), true);
  assert.equal(module.ignores("src/m/entities.ts"), false);
  assert.equal(parent.ignores("src/m/entities/a.ts"), false);
  assert.equal(ownerOf(scopes, "src/m/a.ts"), module);
  assert.equal(ownerOf(scopes, "src/other/a.ts"), parent);
  assert.equal(ownerOf(scopes, "lib/a.ts"), undefined);
  // The root module is the farthest owner, even next to a module with a one-letter name.
  const short = readModuleScopes(root, [".", "a"]).scopes;
  assert.equal(ownerOf(short, "a/x.ts")?.moduleId, "a");
  assert.equal(ownerOf(short, "b/x.ts")?.moduleId, ".");

  assert.equal(cli(root, "check").code, 2);
});
