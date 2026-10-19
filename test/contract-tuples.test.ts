import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { checkLinking, contract, designProject, mdx } from "./helpers.ts";

// Tuples compare by structure on both supported compilers: labels are names, not part of the shape.
function projects(t: TestContext, body: string, source: string) {
  return ["typescript-5", "typescript"].map(compiler => {
    const root = designProject(t, { m: mdx(contract("Port", body)) }, { "src/m/impl.ts": source });
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.symlinkSync(path.resolve("node_modules", compiler), path.join(root, "node_modules/typescript"), "dir");
    return root;
  });
}
const service = (signature: string) => `/** @implements Port */\nexport class Service {${signature}{throw 1}}`;
const codes = (root: string) => checkLinking(root).errors.map(error => error.code);

const equivalent: [string, string, string][] = [
  ["identical labels", "get():[count:number,name:string];", "get():[count:number,name:string]"],
  ["renamed labels", "get():[count:number,name:string];", "get():[total:number,title:string]"],
  ["labelled against unlabelled", "get():[count:number,name:string];", "get():[number,string]"],
  ["unlabelled against labelled", "get():[number,string];", "get():[count:number,name:string]"],
  ["optional and rest elements", "get():[a:number,b?:string,...c:boolean[]];", "get():[x:number,y?:string,...z:boolean[]]"],
  ["readonly tuples", "get():readonly [a:number,b:string];", "get():readonly [number,string]"],
  ["parameter tuples", "put(x:[a:number,b:string]):void;", "put(x:[number,string]):void"],
  ["nested tuples", "get():[a:[b:number,c:string],d:boolean];", "get():[[number,string],boolean]"],
];
/** @tests Cli
 * @covers exact-signatures */
test("tuple labels do not change structural signatures on TS5 and TS6", t => {
  for (const [name, design, signature] of equivalent) {
    assert.deepEqual(projects(t, design, service(signature)).map(codes), [[], []]);
  }
});

// Unassignable returns fail TypeScript's own check; assignable ones and bivariant method parameters
// reach the exact comparison.
const different: [string, string, string, string][] = [
  ["a changed element type", "get():[count:number,name:string];", "get():[count:number,name:number]", "E_TYPE_MISMATCH"],
  ["swapped elements", "get():[count:number,name:string];", "get():[name:string,count:number]", "E_TYPE_MISMATCH"],
  ["a different length", "get():[count:number,name:string];", "get():[count:number,name:string,extra:boolean]", "E_TYPE_MISMATCH"],
  ["an optional element", "get():[count:number,name:string];", "get():[count:number,name?:string]", "E_TYPE_MISMATCH"],
  ["a required element", "get():[count:number,name?:string];", "get():[count:number,name:string]", "E_CONTRACT_SIGNATURE"],
  ["a rest element", "get():[count:number,name:string];", "get():[count:number,...name:string[]]", "E_TYPE_MISMATCH"],
  ["a removed rest element", "get():[count:number,...name:string[]];", "get():[count:number,name:string]", "E_CONTRACT_SIGNATURE"],
  ["a readonly tuple", "get():[count:number,name:string];", "get():readonly [count:number,name:string]", "E_TYPE_MISMATCH"],
  ["a mutable tuple", "get():readonly [count:number,name:string];", "get():[count:number,name:string]", "E_CONTRACT_SIGNATURE"],
  ["an array", "get():[count:number,name:string];", "get():(number|string)[]", "E_TYPE_MISMATCH"],
  ["a nested element type", "get():[a:[b:number],c:string];", "get():[a:[b:string],c:string]", "E_TYPE_MISMATCH"],
  ["a narrower parameter element", "put(x:[a:number,b:string|number]):void;", "put(x:[a:number,b:string]):void", "E_CONTRACT_SIGNATURE"],
  ["a longer parameter tuple", "put(x:[a:number]):void;", "put(x:[a:number,b?:string]):void", "E_CONTRACT_SIGNATURE"],
  ["an optional parameter element", "put(x:[a:number,b:string]):void;", "put(x:[a:number,b?:string]):void", "E_CONTRACT_SIGNATURE"],
  ["a rest parameter element", "put(x:[a:number,b:string]):void;", "put(x:[a:number,...b:string[]]):void", "E_CONTRACT_SIGNATURE"],
  ["a readonly parameter tuple", "put(x:[a:number,b:string]):void;", "put(x:readonly [a:number,b:string]):void", "E_CONTRACT_SIGNATURE"],
  ["an array parameter", "put(x:[a:number,b:number]):void;", "put(x:number[]):void", "E_CONTRACT_SIGNATURE"],
];
/** @tests Cli
 * @covers exact-signatures */
test("tuple arity, element types, optional, rest and readonly changes are rejected", t => {
  for (const [name, design, signature, code] of different) {
    for (const found of projects(t, design, service(signature)).map(codes)) assert.ok(found.includes(code), `${signature}: ${found.join(", ")}`);
  }
});
