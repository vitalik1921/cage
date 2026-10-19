import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { CheckReport } from "../src/check.ts";
import { cli, designFile, designProject, mdx, readFile, writeFile } from "./helpers.ts";

const COMPILERS = ["typescript-5", "typescript"] as const;

const data = (name: string, type: string) => ["/**", " * @data", ` * @description ${name}.`, " */", `export type ${name} = ${type};`].join("\n");
const PORT = ["/**", " * @contract", " * @description Port.", " * @invariant shown the value is shown as given", " * @final", " */", "export interface Port extends View {}"].join("\n");

/** A project whose `@final` contract Port extends the `@data` alias View, locked as the given designs have it. */
function locked(t: TestContext, compiler: string, ...blocks: string[]): string {
  const root = designProject(t, { m: mdx(...blocks, PORT) });
  fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
  fs.symlinkSync(path.resolve("node_modules", compiler), path.join(root, "node_modules/typescript"), "dir");
  assert.equal(cli(root, "lock").code, 0, compiler);
  return root;
}

/** The lock violations of Port once the designs are the given ones, and the design phase's errors besides. */
function violations(root: string, ...blocks: string[]) {
  writeFile(root, designFile("m"), mdx(...blocks, PORT));
  const { stdout } = cli(root, "check", "--phase", "design", "--format", "json");
  const { diagnostics } = JSON.parse(stdout) as CheckReport;
  return {
    locks: diagnostics.filter((diagnostic) => diagnostic.code === "E_LOCK_VIOLATION" && diagnostic.contract === "Port").map(({ message }) => message),
    others: diagnostics.filter((diagnostic) => diagnostic.severity === "error" && diagnostic.code !== "E_LOCK_VIOLATION").map(({ code, message }) => `${code}: ${message}`),
  };
}

/** @tests Cli
 * @covers contract-inheritance locks */
test("a derived contract's lock holds the modifiers and types a mapped base gives its inherited members", (t) => {
  const base = data("Base", "{ readonly value: string; label?: string; count: number }");
  const changes: [what: string, from: string, to: string, member: string][] = [
    ["readonly taken away", "Readonly<Base>", "{ -readonly [K in keyof Base]: Base[K] }", "value"],
    ["readonly added", "Pick<Base, keyof Base>", "Readonly<Base>", "count"],
    ["optional added", "Readonly<Base>", "Partial<Readonly<Base>>", "value"],
    ["optional taken away", "Readonly<Base>", "Required<Readonly<Base>>", "label"],
    ["the type changed", "Readonly<Base>", "{ readonly [K in keyof Base]: number }", "value"],
  ];
  for (const compiler of COMPILERS) {
    for (const [what, from, view, member] of changes) {
      const root = locked(t, compiler, base, data("View", from));
      assert.deepEqual(violations(root, base, data("View", from)), { locks: [], others: [] }, `${compiler}: ${what}: unchanged`);
      const found = violations(root, base, data("View", view));
      assert.deepEqual(found.others, [], `${compiler}: ${what}`);
      assert.equal(found.locks.length, 1, `${compiler}: ${what}: ${JSON.stringify(found)}`);
      assert.match(found.locks[0], new RegExp(`\`${member}\``), `${compiler}: ${what}`);
    }

    // The repro: a writable mapping of a readonly base.
    const plain = data("Base", "{ readonly value: string }");
    const root = locked(t, compiler, plain, data("View", "Readonly<Base>"));
    const found = violations(root, plain, data("View", "{ -readonly [K in keyof Base]: Base[K] }"));
    assert.equal(found.locks.length, 1, compiler);
    assert.match(found.locks[0], /`value`/, compiler);
  }
});

/** @tests Cli
 * @covers contract-inheritance locks */
test("layout, comments and an equivalent alias of a mapped base leave a derived contract's lock as it was", (t) => {
  const base = data("Base", "{ readonly value: string; label?: string }");
  const equivalents: [what: string, blocks: string[]][] = [
    ["layout and comments", [base, data("View", "Readonly< /* all of it */ Base >")]],
    ["the mapping written out", [base, data("View", "{ readonly [K in keyof Base]: Base[K] }")]],
    ["an alias in between", [base, data("Inner", "Base"), data("View", "Readonly<Inner>")]],
    ["the base reformatted", [data("Base", "{\n  readonly value: string;   // shown\n  label?: string\n}"), data("View", "Readonly<Base>")]],
  ];
  for (const compiler of COMPILERS) {
    const root = locked(t, compiler, base, data("View", "Readonly<Base>"));
    const record = readFile(root, ".cage/lock.json");
    // Locking again without a change records nothing new.
    assert.match(cli(root, "lock").stdout, /0 recorded, 0 extended, 1 unchanged/, compiler);
    assert.equal(readFile(root, ".cage/lock.json"), record, compiler);
    for (const [what, blocks] of equivalents) {
      const found = violations(root, ...blocks);
      assert.deepEqual(found, { locks: [], others: [] }, `${compiler}: ${what}`);
    }
  }
});

/** @tests Cli
 * @covers contract-inheritance locks */
test("an accessor a mapped base makes a field is locked as a field, and the mapping that changes it is a violation", (t) => {
  const base = data("Base", "{ get value(): string; set value(input: string) }");
  for (const compiler of COMPILERS) {
    const root = locked(t, compiler, base, data("View", "{ [K in keyof Base]: Base[K] }"));
    const record = JSON.stringify(JSON.parse(readFile(root, ".cage/lock.json")));
    assert.match(record, /"value":"get value\(\): string; set value\(input: string\); as field string"/, `${compiler}: ${record}`);
    assert.deepEqual(violations(root, base, data("View", "{ [K in keyof Base]: Base[K] }")), { locks: [], others: [] }, compiler);

    const readonly = violations(root, base, data("View", "Readonly<Base>"));
    assert.deepEqual(readonly.others, [], compiler);
    assert.equal(readonly.locks.length, 1, compiler);
    assert.match(readonly.locks[0], /`value`/, compiler);
  }

  for (const compiler of COMPILERS) {
    // Inherited as an accessor without a mapping, the member is its declaration: nothing is added to its record.
    const root = designProject(t, { m: mdx(base, PORT.replace("extends View", "extends Base")) });
    fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
    fs.symlinkSync(path.resolve("node_modules", compiler), path.join(root, "node_modules/typescript"), "dir");
    assert.equal(cli(root, "lock").code, 0, compiler);
    const record = JSON.stringify(JSON.parse(readFile(root, ".cage/lock.json")));
    assert.match(record, /"value":"get value\(\): string; set value\(input: string\);"/, `${compiler}: ${record}`);
  }
});
