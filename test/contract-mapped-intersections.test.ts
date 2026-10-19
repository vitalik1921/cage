import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { checkLinking, contract, designProject, mdx } from "./helpers.ts";

const BOX = 'class Box<T>{get value():string{return ""}set value(x:T){}}\n';

// One project per compiler: the bundled TypeScript 6 and the TypeScript 5 test install.
function compatible(t: TestContext, body: string, type: string): boolean[] {
  return ["typescript-5", "typescript"].map(compiler => {
    const source = `${BOX}/** @implements Port */\nexport const service:${type}={tag:""} as ${type};`;
    const root = designProject(t, { m: mdx(contract("Port", body)) }, { "src/m/impl.ts": source });
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.symlinkSync(path.resolve("node_modules", compiler), path.join(root, "node_modules/typescript"), "dir");
    const result = checkLinking(root);
    const found = result.linking.implementations.find(i => i.name === "service");
    assert.ok(found, `${compiler}: service is linked`);
    return found.compatible === true && result.errors.length === 0;
  });
}

/** @tests Cli
 * @covers exact-signatures */
test("mapped accessor members are ordinary fields inside intersections, in either order", t => {
  assert.deepEqual(compatible(t, "value?:string;tag:string;", "Partial<Box<number>>&{tag:string}"), [true, true]);
  assert.deepEqual(compatible(t, "value?:string;tag:string;", "{tag:string}&Partial<Box<number>>"), [true, true]);
  assert.deepEqual(compatible(t, "readonly value?:string;tag:string;", "Readonly<Partial<Box<number>>>&{tag:string}"), [true, true]);
});

/** @tests Cli
 * @covers exact-signatures */
test("mapped intersection members still report wrong types, modifiers and optionality", t => {
  assert.deepEqual(compatible(t, "value?:number;tag:string;", "Partial<Box<number>>&{tag:string}"), [false, false]);
  assert.deepEqual(compatible(t, "value:string;tag:string;", "Partial<Box<number>>&{tag:string}"), [false, false]);
  assert.deepEqual(compatible(t, "readonly value?:string;tag:string;", "Partial<Box<number>>&{tag:string}"), [false, false]);
  assert.deepEqual(compatible(t, "value?:string;tag:string;", "Readonly<Partial<Box<number>>>&{tag:string}"), [false, false]);
  assert.deepEqual(compatible(t, "value?:string;tag:number;", "{tag:string}&Partial<Box<number>>"), [false, false]);
});

/** @tests Cli
 * @covers exact-signatures */
test("genuine setters inside intersections keep their own write type", t => {
  assert.deepEqual(compatible(t, "value:string;tag:string;", "Box<number>&{tag:string}"), [false, false]);
  assert.deepEqual(compatible(t, "value:string;tag:string;", "{tag:string}&Box<number>"), [false, false]);
  assert.deepEqual(compatible(t, "value:string;tag:string;", "Box<string>&{tag:string}"), [true, true]);
  assert.deepEqual(compatible(t, "value:string;tag:string;", "{tag:string}&Box<string>"), [true, true]);
});
