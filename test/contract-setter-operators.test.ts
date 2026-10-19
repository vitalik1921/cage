import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { checkLinking, contract, data, designProject, mdx } from "./helpers.ts";

// TypeScript's own assignability compares read types only, so a setter input difference reaches the shape comparison.
// Each project has one design Box, one contract and one implementation, checked with TypeScript 5 and 6.
function codes(t: TestContext, setter: string, expected: string, implementation: string, prelude = "") {
  return ["typescript-5", "typescript"].map(compiler => {
    const root = designProject(t, { m: mdx(data("Box<T>", `{get v():string;set v(x:${setter})}`), contract("Port", `x:${expected};`)) }, {
      "src/m/impl.ts": `import type {Box} from "./.cage/design.ts";\n${prelude}/** @implements Port */\nexport class Service {x!:${implementation}}`,
    });
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.symlinkSync(path.resolve("node_modules", compiler), path.join(root, "node_modules/typescript"), "dir");
    return checkLinking(root).errors.map(d => d.code);
  });
}

/** @tests Cli
 * @covers exact-signatures */
test("a keyof setter over different arguments is reported as a different signature", t => {
  assert.deepEqual(codes(t, "keyof T", "Box<{a:1}>", "Box<{b:1}>"), [["E_CONTRACT_SIGNATURE"], ["E_CONTRACT_SIGNATURE"]]);
  assert.deepEqual(codes(t, "keyof T", "Box<{a:1}>", "Box<{a:1;b:1}>"), [["E_CONTRACT_SIGNATURE"], ["E_CONTRACT_SIGNATURE"]]);
});

/** @tests Cli
 * @covers exact-signatures */
test("template, indexed access and string mapping setters over different arguments are uncheckable, never approved", t => {
  for (const [setter, expected, implementation] of [
    ["`${T & string}!`", 'Box<"a">', 'Box<"b">'],
    ["T[keyof T]", "Box<{a:1}>", "Box<{a:2}>"],
    ["Uppercase<T & string>", 'Box<"a">', 'Box<"b">'],
  ]) assert.deepEqual(codes(t, setter, expected, implementation), [["E_CONTRACT_UNCHECKABLE"], ["E_CONTRACT_UNCHECKABLE"]], setter);
});

/** @tests Cli
 * @covers exact-signatures */
test("deferred setter inputs over equal arguments conform", t => {
  for (const [setter, expected, implementation] of [
    ["keyof T", "Box<{a:1}>", "Box<{a:1}>"],
    ["keyof T", "Box<{a:1}>", "Box<{a:2}>"],
    ["`${T & string}!`", 'Box<"a">', 'Box<"a">'],
    ["T[keyof T]", "Box<{a:1}>", "Box<{a:1}>"],
    ["Uppercase<T & string>", 'Box<"a">', 'Box<"a">'],
  ]) assert.deepEqual(codes(t, setter, expected, implementation), [[], []], `${setter} ${implementation}`);
});

/** @tests Cli
 * @covers exact-signatures */
test("a keyof setter matches the same literal keys written out and no other input", t => {
  assert.deepEqual(codes(t, "keyof T", "Box<{a:1;b:1}>", '{get v():string;set v(x:"a"|"b")}'), [[], []]);
  for (const input of ['"a"', "string"]) {
    assert.deepEqual(codes(t, "keyof T", "Box<{a:1;b:1}>", `{get v():string;set v(x:${input})}`), [["E_CONTRACT_SIGNATURE"], ["E_CONTRACT_SIGNATURE"]], input);
  }
});

/** @tests Cli
 * @covers exact-signatures */
test("straightforward generic setters stay exact", t => {
  assert.deepEqual(codes(t, "T", "Box<string>", "Box<string>"), [[], []]);
  assert.deepEqual(codes(t, "T[]", "Box<string>", "{get v():string;set v(x:string[])}"), [[], []]);
  assert.deepEqual(codes(t, "T", "Box<string>", "Box<number>"), [["E_CONTRACT_SIGNATURE"], ["E_CONTRACT_SIGNATURE"]]);
  assert.deepEqual(codes(t, "T | null", 'Box<"a">', 'Box<"b">'), [["E_CONTRACT_SIGNATURE"], ["E_CONTRACT_SIGNATURE"]]);
});

/** @tests Cli
 * @covers exact-signatures */
test("an undecidable union candidate does not taint a setter input proved equal by another", t => {
  const crate = "class Crate<U>{get v():string{return \"\"} set v(x:`${U & string}?` | `${U & string}!`){}}\n";
  assert.deepEqual(codes(t, "`${T & string}!` | `${T & string}?`", 'Box<"a">', 'Crate<"a">', crate), [[], []]);
});

/** @tests Cli
 * @covers exact-signatures */
test("generic callbacks with renamed deferred operators conform", t => {
  assert.deepEqual(codes(t, "T", "<T,K extends keyof T>(x:T[K],k:keyof T)=>`${K & string}!`", "<U,J extends keyof U>(x:U[J],k:keyof U)=>`${J & string}!`"), [[], []]);
});
