import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { checkLinking, contract, designProject, mdx, PROJECT_OPTIONS } from "./helpers.ts";

const compilers = ["typescript-5", "typescript"];

/** One contract `Port` and one implementation per project, checked with the given compiler. */
function errors(t: TestContext, compiler: string, body: string, source: string, options: object = PROJECT_OPTIONS) {
  const root = designProject(t, { m: mdx(contract("Port", body)) }, {
    "tsconfig.json": JSON.stringify({ compilerOptions: options }),
    "src/m/impl.ts": `/** @implements Port */\n${source}`,
  });
  fs.mkdirSync(path.join(root, "node_modules"));
  fs.symlinkSync(path.resolve("node_modules", compiler), path.join(root, "node_modules/typescript"), "dir");
  return checkLinking(root).errors;
}

const equivalent: [string, string, string][] = [
  ["unknown already admits undefined before a required parameter", "run(a:unknown,b:number):void;", "export class Service {run(a:unknown=1,b:number):void{}}"],
  ["any already admits undefined before a required parameter", "run(a:any,b:number):void;", "export class Service {run(a:any=1,b:number):void{}}"],
  ["void already admits undefined before a required parameter", "run(a:void,b:number):void;", "export class Service {run(a:void=undefined,b:number):void{}}"],
  ["method default for an optional parameter", "run(n?:number):void;", "export class Service {run(n=1):void{}}"],
  ["method default with a declared undefined", "run(n?:number|undefined):void;", "export class Service {run(n:number|undefined=1):void{}}"],
  ["method optional for a default", "run(n?:number):void;", "export class Service {run(n?:number):void{}}"],
  ["method default before a required parameter", "run(a:number|undefined,b:number):void;", "export class Service {run(a=1,b:number):void{}}"],
  ["method nullable default", "run(n?:number|null):void;", "export class Service {run(n:number|null=1):void{}}"],
  ["function contract default", "(n?:number):void;", "export const run=(n=1):void=>{};"],
  ["function declaration default", "(n?:number):void;", "export function run(n=1):void{}"],
  ["callback field default", "fn:(n?:number)=>void;", "export const service={fn:(n=1):void=>{}};"],
  ["returned callback default", "make():(n?:number)=>void;", "export class Service {make(){return (n=1):void=>{}}}"],
  ["callback inferred from a default", "run(cb?:(n?:number)=>void):void;", "export class Service {run(cb=(n=1):void=>{}):void{}}"],
];

const rejected = ["E_CONTRACT_SIGNATURE", "E_TYPE_MISMATCH"];

const different: [string, string, string][] = [
  ["method default against a null-accepting optional", "run(n?:number|null):void;", "export class Service {run(n=1):void{}}"],
  ["method null-accepting default against an optional", "run(n?:number):void;", "export class Service {run(n:number|null=1):void{}}"],
  ["method default against a required parameter", "run(n:number):void;", "export class Service {run(n=1):void{}}"],
  ["method default against a required undefined", "run(n:number|undefined):void;", "export class Service {run(n=1):void{}}"],
  ["method default before required against a defined type", "run(a:number,b:number):void;", "export class Service {run(a=1,b:number):void{}}"],
  ["method default of another type", "run(n?:string):void;", "export class Service {run(n=1):void{}}"],
  ["method default against a rest", "run(...n:number[]):void;", "export class Service {run(n=1):void{}}"],
  ["function contract default against a required parameter", "(n:number):void;", "export const run=(n=1):void=>{};"],
  ["function contract default against null", "(n?:number|null):void;", "export function run(n=1):void{}"],
  ["callback field default against a required parameter", "fn:(n:number)=>void;", "export const service={fn:(n=1):void=>{}};"],
  ["callback field default against null", "fn:(n?:number|null)=>void;", "export const service={fn:(n=1):void=>{}};"],
  ["returned callback default against a required parameter", "make():(n:number)=>void;", "export class Service {make(){return (n=1):void=>{}}}"],
];

/** @tests Cli
 * @covers exact-signatures */
test("optional and default parameters have the same caller-visible signature on TS5 and TS6", t => {
  for (const compiler of compilers) for (const [name, body, source] of equivalent) {
    assert.deepEqual(errors(t, compiler, body, source), [], `${compiler}: ${name}`);
  }
});

/** @tests Cli
 * @covers exact-signatures */
test("default parameter normalization preserves arity, null, rest and type differences", t => {
  for (const compiler of compilers) for (const [name, body, source] of different) {
    const found = errors(t, compiler, body, source);
    assert.equal(found.length, 1, `${compiler}: ${name}: ${JSON.stringify(found)}`);
    assert.ok(rejected.includes(found[0].code), `${compiler}: ${name}: ${JSON.stringify(found)}`);
  }
});

/** @tests Cli
 * @covers exact-signatures */
test("without strictNullChecks defaults match optional parameters but retain arity", t => {
  for (const compiler of compilers) {
    const loose = { ...PROJECT_OPTIONS, strict: false };
    assert.deepEqual(errors(t, compiler, "run(n?:number):void;", "export class Service {run(n=1):void{}}", loose), []);
    assert.deepEqual(errors(t, compiler, "run(a:number,b:number):void;", "export class Service {run(a=1,b:number):void{}}", loose), []);
    assert.deepEqual(errors(t, compiler, "run(n:number):void;", "export class Service {run(n=1):void{}}", loose).map(d => d.code), ["E_CONTRACT_SIGNATURE"]);
    assert.deepEqual(errors(t, compiler, "run(a:number,b:number):void;", "export class Service {run(a=1,b?:number):void{}}", loose).map(d => d.code), ["E_CONTRACT_SIGNATURE"]);
  }
});
