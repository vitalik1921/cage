import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import ts from "typescript";
import ts5 from "typescript-5";
import { shapeChecker } from "../src/contract-shape.ts";
import { checkLinking, contract, designProject, mdx, scratchDirectory, writeFile } from "./helpers.ts";

// A constraint on another parameter (B extends A, infer B extends U) must survive the comparison: its base
// constraint alone erases it. One contract and one implementation, checked with TypeScript 5 and 6.
function codes(t: TestContext, expected: string, actual: string, prelude = "") {
  return ["typescript-5", "typescript"].map(compiler => {
    const root = designProject(t, { m: mdx(contract("Port", `get():${expected};`)) }, {
      "src/m/impl.ts": `${prelude}\n/** @implements Port */\nexport class Service {get():${actual}{throw 1}}`,
    });
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.symlinkSync(path.resolve("node_modules", compiler), path.join(root, "node_modules/typescript"), "dir");
    return checkLinking(root).errors.map(d => d.code);
  });
}
const rejected = (result: string[][]) => result.map(found => found.length > 0);

// The shape comparison alone, where TypeScript's own assignability already refuses the pair.
function shape(t: TestContext, expected: string, actual: string, prelude = "") {
  return [ts5 as unknown as typeof ts, ts].map(compiler => {
    const root = scratchDirectory(t, "constraints");
    const file = path.join(root, "types.ts");
    writeFile(root, "types.ts", `${prelude}\nexport type Expected=${expected};\nexport type Actual=${actual};\n`);
    const program = compiler.createProgram([file], { strict: true, noEmit: true });
    const checker = program.getTypeChecker();
    const aliases = program.getSourceFile(file)!.statements.filter(compiler.isTypeAliasDeclaration);
    const type = (name: string) => checker.getTypeAtLocation(aliases.find(a => a.name.text === name)!.name);
    const comparison = shapeChecker(compiler, checker);
    const same = comparison.equal(type("Expected"), type("Actual"));
    return same ? "equal" : comparison.limited ? "uncheckable" : "different";
  });
}

/** @tests Cli
 * @covers exact-signatures */
test("infer constraints on outer and earlier parameters conform when renamed", t => {
  // TypeScript refuses these renamed pairs itself; the shape comparison accepts them and refuses changed ones.
  for (const [expected, actual, verdict] of [
    ["<T,U>(t:T,u:U)=>T extends [infer B extends U]?B:0", "<X,Y>(t:X,u:Y)=>X extends [infer C extends Y]?C:0", "equal"],
    ["<T>(t:T)=>T extends [infer B extends keyof T]?B:0", "<X>(t:X)=>X extends [infer C extends keyof X]?C:0", "equal"],
    ["<T,U>(t:T,u:U)=>T extends [infer B extends U]?B:0", "<X,Y>(t:X,u:Y)=>X extends [infer C extends X]?C:0", "different"],
    ["<T>(t:T)=>T extends [infer A,infer B extends A]?B:0", "<X>(t:X)=>X extends [infer C extends D,infer D]?D:0", "different"],
    ["<T>(t:T)=>T extends [infer A,infer B extends A]?B:0", "<X>(t:X)=>X extends [infer C,infer D extends C]?D:0", "equal"],
  ]) assert.deepEqual(shape(t, expected, actual), [verdict, verdict], actual);
  assert.deepEqual(codes(t, "<T>(t:T)=>T extends [infer B extends string]?B:0", "<X>(t:X)=>X extends [infer C extends string]?C:0"), [[], []]);
});

/** @tests Cli
 * @covers exact-signatures */
test("changed infer constraints are never approved", t => {
  for (const [expected, actual] of [
    ["<T,U>(t:T,u:U)=>T extends [infer B extends U]?B:0", "<T,U>(t:T,u:U)=>T extends [infer B]?B:0"],
    ["<T,U>(t:T,u:U)=>T extends [infer B extends keyof T]?B:0", "<T,U>(t:T,u:U)=>T extends [infer B extends PropertyKey]?B:0"],
    ["<T,U>(t:T,u:U)=>T extends [infer B extends U]?B:0", "<X,Y>(t:X,u:Y)=>X extends [infer C extends X]?C:0"],
  ]) assert.deepEqual(rejected(codes(t, expected, actual)), [true, true], actual);
  // In an instantiated conditional an infer constraint on the outer parameter has an invisible substitution.
  const outer = "interface Outer<X>{f<T>(t:T):T extends [infer B extends X]?B:0}";
  assert.deepEqual(shape(t, "Outer<string>", "Outer<string>", outer), ["equal", "equal"]);
  assert.deepEqual(shape(t, "Outer<string>", "Outer<number>", outer), ["uncheckable", "uncheckable"]);
});

/** @tests Cli
 * @covers exact-signatures */
test("type parameter constraints on other parameters conform when renamed or nested", t => {
  for (const [expected, actual] of [
    ["<A,B extends A>(a:A,b:B)=>void", "<X,Y extends X>(a:X,b:Y)=>void"],
    ["<A,B extends keyof A>(a:A,b:B)=>void", "<X,Y extends keyof X>(a:X,b:Y)=>void"],
    ["<A>(a:A)=><B extends A>(b:B)=>void", "<X>(a:X)=><Y extends X>(b:Y)=>void"],
    ["<A extends unknown>(a:A)=>void", "<X>(a:X)=>void"],
  ]) assert.deepEqual(codes(t, expected, actual), [[], []], actual);
});

/** @tests Cli
 * @covers exact-signatures */
test("changed type parameter constraints are never approved", t => {
  for (const [expected, actual] of [
    ["<A,B extends A>(a:A,b:B)=>void", "<A,B>(a:A,b:B)=>void"],
    ["<A,B extends keyof A>(a:A,b:B)=>void", "<A,B extends PropertyKey>(a:A,b:B)=>void"],
    ["<A,B extends A>(a:A,b:B)=>void", "<X extends Y,Y>(a:X,b:Y)=>void"],
    ["<A,C>(a:A,c:C)=><B extends A>(b:B)=>void", "<X,Z>(a:X,c:Z)=><Y extends Z>(b:Y)=>void"],
  ]) assert.deepEqual(rejected(codes(t, expected, actual)), [true, true], actual);
});

/** @tests Cli
 * @covers exact-signatures */
test("constraints of an instantiated generic method are compared through its own parameters", t => {
  const prelude = "interface Methods<Q>{f<C,D extends keyof C>(c:C,d:D):Q}";
  assert.deepEqual(codes(t, "{f<A,B extends keyof A>(a:A,b:B):string}", "Methods<string>", prelude), [[], []]);
  const changed = "interface Methods<Q>{f<C,D extends PropertyKey>(c:C,d:D):Q}";
  assert.deepEqual(rejected(codes(t, "{f<A,B extends keyof A>(a:A,b:B):string}", "Methods<string>", changed)), [true, true]);
  // A constraint on the instantiated outer parameter: its substitution is not visible, so equal raw constraints prove nothing.
  const outer = "interface Outer<X>{f<B extends X>(b:B):void}";
  assert.deepEqual(shape(t, "Outer<string>", "Outer<string>", outer), ["equal", "equal"]);
  assert.deepEqual(shape(t, "Outer<string>", "Outer<number>", outer), ["uncheckable", "uncheckable"]);
});
