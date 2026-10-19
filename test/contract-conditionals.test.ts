import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import ts from "typescript";
import ts5 from "typescript-5";
import { shapeChecker } from "../src/contract-shape.ts";
import { checkLinking, contract, data, designProject, mdx, scratchDirectory, writeFile } from "./helpers.ts";

const compilers = [["typescript-5", ts5 as unknown as typeof ts], ["typescript", ts]] as const;

// One implementation of one contract, checked with TypeScript 5 and with the bundled TypeScript 6.
function errors(t: TestContext, body: string, source: string) {
  return compilers.map(([compiler]) => {
    const root = designProject(t, { m: mdx(contract("Port", body), data("Is<X>", "X extends string ? 1 : 2")) }, { "src/m/impl.ts": source });
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.symlinkSync(path.resolve("node_modules", compiler), path.join(root, "node_modules/typescript"), "dir");
    return checkLinking(root).errors.map(d => d.code);
  });
}
const project = (expected: string, actual: string): [string, string] =>
  [`fn:${expected};`, `/** @implements Port */\nexport const service:{fn:${actual}}={fn:()=>{throw 1}};`];

// The shape comparison alone, without the assignability check in front of it.
function shapeEqual(t: TestContext, expected: string, actual: string) {
  return compilers.map(([, compiler]) => {
    const root = scratchDirectory(t, "conditionals");
    const file = path.join(root, "types.ts");
    writeFile(root, "types.ts", `type Is<X>=X extends string?1:2;\nexport type Expected=${expected};\nexport type Actual=${actual};\n`);
    const program = compiler.createProgram([file], { strict: true, noEmit: true });
    const checker = program.getTypeChecker();
    const aliases = program.getSourceFile(file)!.statements.filter(compiler.isTypeAliasDeclaration);
    const type = (name: string) => checker.getTypeAtLocation(aliases.find(a => a.name.text === name)!.name);
    const shape = shapeChecker(compiler, checker);
    const same = shape.equal(type("Expected"), type("Actual"));
    assert.equal(shape.limited, false);
    return same;
  });
}

const equivalent: [string, string, string][] = [
  ["renamed type parameter", "<T>(x:T)=>T extends string?1:2", "<U>(x:U)=>U extends string?1:2"],
  ["renamed constrained parameter", "<T extends string|number>(x:T)=>T extends string?[T]:T[]", "<U extends string|number>(x:U)=>U extends string?[U]:U[]"],
  ["renamed nested scopes", "<T>(x:T)=><V>(y:V)=>T extends V?[T,V]:V", "<U>(x:U)=><W>(y:W)=>U extends W?[U,W]:W"],
  ["renamed infer parameter", "<T>(x:T)=>T extends Array<infer E>?E:never", "<U>(x:U)=>U extends Array<infer F>?F:never"],
  ["renamed constrained infer parameter", "<T>(x:T)=>T extends [infer E extends string]?E:0", "<U>(x:U)=>U extends [infer F extends string]?F:0"],
  ["nested conditional branches", "<T>(x:T)=>T extends string?1:T extends number?2:3", "<U>(x:U)=>U extends string?1:U extends number?2:3"],
  ["a conditional under an alias", "<T>(x:T)=>Is<T>", "<U>(x:U)=>U extends string?1:2"],
];
const mutations: [string, string, string][] = [
  ["swapped branches", "<T>(x:T)=>T extends string?1:2", "<U>(x:U)=>U extends string?2:1"],
  ["changed extends type", "<T>(x:T)=>T extends string?1:2", "<U>(x:U)=>U extends number?1:2"],
  ["changed check type", "<T,V>(x:T,y:V)=>T extends string?1:2", "<U,W>(x:U,y:W)=>W extends string?1:2"],
  ["swapped nested scopes", "<T>(x:T)=><V>(y:V)=>T extends V?1:2", "<U>(x:U)=><W>(y:W)=>W extends U?1:2"],
  ["changed constraint", "<T extends string|number>(x:T)=>T extends string?1:2", "<U extends string|boolean>(x:U)=>U extends string?1:2"],
  ["non-distributive check", "<T>(x:T)=>T extends string?1:2", "<U>(x:U)=>[U] extends [string]?1:2"],
  ["infer result replaced", "<T>(x:T)=>T extends Array<infer E>?E:never", "<U>(x:U)=>U extends Array<infer F>?U:never"],
  ["changed infer constraint", "<T>(x:T)=>T extends [infer E extends string]?E:0", "<U>(x:U)=>U extends [infer F extends number]?F:0"],
  ["inner conditional branches swapped", "<T>(x:T)=>T extends string?1:T extends number?2:3", "<U>(x:U)=>U extends string?1:U extends number?3:2"],
  ["true branch narrowed differently", "<T>(x:T)=>T extends string?[T]:0", "<U>(x:U)=>U extends string?[string]:0"],
  ["an alias with swapped branches", "<T>(x:T)=>Is<T>", "<U>(x:U)=>U extends string?2:1"],
];

/** @tests Cli
 * @covers exact-signatures */
test("a generic conditional callback conforms with a renamed type parameter", t => {
  const roots = errors(t, "fn:<T>(x:T)=>T extends string?1:2;", "/** @implements Port */\nexport const service={fn:<U>(x:U):U extends string?1:2=>{throw 1}};");
  assert.deepEqual(roots, [[], []]);
});

/** @tests Cli
 * @covers exact-signatures */
test("equivalent conditional signatures conform under renamed generic parameters", t => {
  for (const [name, expected, actual] of equivalent) {
    assert.deepEqual(shapeEqual(t, expected, actual), [true, true]);
    assert.deepEqual(errors(t, ...project(expected, actual)), [[], []]);
  }
});

/** @tests Cli
 * @covers exact-signatures */
test("changed conditional checks, scopes, constraints and branches are rejected", t => {
  for (const [name, expected, actual] of mutations) {
    assert.deepEqual(shapeEqual(t, expected, actual), [false, false]);
    assert.deepEqual(errors(t, ...project(expected, actual)).map(codes => codes.length > 0), [true, true]);
  }
});
