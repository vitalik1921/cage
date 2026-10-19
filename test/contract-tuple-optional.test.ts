import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { loadTypeScript } from "../src/typescript.ts";
import { PROJECT_OPTIONS, checkLinking, contract, designProject, mdx, writeFile } from "./helpers.ts";

// Under exactOptionalPropertyTypes an optional tuple element does not accept a written undefined
// unless its type says so: [string, number?] and [string, (number|undefined)?] are different contracts.
const COMPILERS = ["typescript-5", "typescript"];
function project(t: TestContext, compiler: string, body: string, source: string, exact = true) {
  const root = designProject(t, { m: mdx(contract("Port", body)) }, { "src/m/impl.ts": source });
  writeFile(root, "tsconfig.json", JSON.stringify({ compilerOptions: { ...PROJECT_OPTIONS, exactOptionalPropertyTypes: exact } }));
  fs.mkdirSync(path.join(root, "node_modules"));
  fs.symlinkSync(path.resolve("node_modules", compiler), path.join(root, "node_modules/typescript"), "dir");
  return root;
}
const codes = (root: string) => checkLinking(root).errors.map(error => error.code);
const ALIASES = "type Opt<T> = [string, T?];\ntype ReadonlyOpt<T> = readonly [string, T?];\n";
const service = (signature: string) => `${ALIASES}/** @implements Port */\nexport class Service {${signature}{throw 1}}`;

/** @tests Cli
 * @covers exact-signatures */
test("exact optional tuples: the compiler rejects a written undefined only for a missing-only element", t => {
  for (const compiler of COMPILERS) {
    const root = project(t, compiler, "run():void;", "/** @implements Port */\nexport class Service {run():void{}}");
    writeFile(root, "src/m/proof.ts", [
      "export const open: [string, (number | undefined)?] = [\"a\", undefined];",
      "export const closed: [string, number?] = [\"a\", undefined];",
      "export const widened: [string, (number | undefined)?] = closed;",
      "export const narrowed: [string, number?] = open;",
    ].join("\n"));
    const { ts } = loadTypeScript(root);
    const program = ts.createProgram([path.join(root, "src/m/proof.ts")], { ...ts.convertCompilerOptionsFromJson(JSON.parse(fs.readFileSync(path.join(root, "tsconfig.json"), "utf8")).compilerOptions, root).options });
    const lines = ts.getPreEmitDiagnostics(program).filter(d => d.file?.fileName.endsWith("proof.ts")).map(d => d.file!.getLineAndCharacterOfPosition(d.start!).line + 1);
    assert.deepEqual([...new Set(lines)].sort(), [2, 4], compiler);
  }
});

/** @tests Cli
 * @covers exact-signatures */
test("exact optional tuples: an explicit undefined element differs from a missing-only element", t => {
  const cases: [string, string, string][] = [
    ["get():[string,(number|undefined)?];", "get():[string,number?]", "E_CONTRACT_SIGNATURE"],
    ["get():[a:string,b?:number|undefined];", "get():[x:string,y?:number]", "E_CONTRACT_SIGNATURE"],
    ["get():[string,(number|undefined)?];", "get():Opt<number>", "E_CONTRACT_SIGNATURE"],
    ["get():readonly [string,(number|undefined)?];", "get():readonly [string,number?]", "E_CONTRACT_SIGNATURE"],
    ["get():readonly [string,(number|undefined)?];", "get():ReadonlyOpt<number>", "E_CONTRACT_SIGNATURE"],
    ["get():[[string,(number|undefined)?]];", "get():[[string,number?]]", "E_CONTRACT_SIGNATURE"],
    // Reverse direction: the return is not assignable, so TypeScript's own check reports it.
    ["get():[string,number?];", "get():[string,(number|undefined)?]", "E_TYPE_MISMATCH"],
    ["get():ReadonlyArray<string|number>|[string,number?];", "get():ReadonlyArray<string|number>|Opt<number|undefined>", "E_TYPE_MISMATCH"],
    // Method parameters are bivariant, so both directions reach the exact comparison.
    ["put(x:[string,number?]):void;", "put(x:[string,(number|undefined)?]):void", "E_CONTRACT_SIGNATURE"],
    ["put(x:[string,(number|undefined)?]):void;", "put(x:Opt<number>):void", "E_CONTRACT_SIGNATURE"],
    ["put(x:readonly [string,number?]):void;", "put(x:ReadonlyOpt<number|undefined>):void", "E_CONTRACT_SIGNATURE"],
  ];
  for (const compiler of COMPILERS) for (const [design, signature, code] of cases) {
    const found = codes(project(t, compiler, design, service(signature)));
    assert.ok(found.includes(code), `${compiler} ${design} / ${signature}: ${found.join(", ")}`);
  }
});

/** @tests Cli
 * @covers exact-signatures */
test("exact optional tuples: equivalent optional elements still match", t => {
  const cases: [string, string][] = [
    ["get():[string,number?];", "get():[string,number?]"],
    ["get():[string,number?];", "get():[label:string,count?:number]"],
    ["get():[string,number?];", "get():Opt<number>"],
    ["get():[string,(number|undefined)?];", "get():[string,(number|undefined)?]"],
    ["get():[string,(number|undefined)?];", "get():Opt<number|undefined>"],
    ["get():[string,undefined?];", "get():[string,undefined?]"],
    ["get():readonly [string,number?];", "get():ReadonlyOpt<number>"],
    ["get():readonly [string,(number|undefined)?];", "get():ReadonlyOpt<number|undefined>"],
    ["get():[string,number?,...boolean[]];", "get():[a:string,b?:number,...c:boolean[]]"],
    ["put(x:[string,number?]):void;", "put(x:Opt<number>):void"],
  ];
  for (const compiler of COMPILERS) {
    for (const [design, signature] of cases) assert.deepEqual(codes(project(t, compiler, design, service(signature))), [], `${compiler} ${design} / ${signature}`);
    // Generic elements compare under substitution, where only the markers can decide.
    const generic = project(t, compiler, "fn:<T>(x:T)=>[T,T?];", "/** @implements Port */\nexport const service={fn:<U>(x:U):[U,U?]=>{throw 1}};");
    assert.deepEqual(codes(generic), [], compiler);
    const widened = project(t, compiler, "fn:<T>(x:[T,T?])=>void;", "/** @implements Port */\nexport const service={fn:<U>(x:[U,(U|undefined)?]):void=>{}};");
    assert.deepEqual(codes(widened), ["E_CONTRACT_SIGNATURE"], compiler);
  }
});

/** @tests Cli
 * @covers exact-signatures */
test("optional tuples without exactOptionalPropertyTypes: explicit undefined is the same element", t => {
  const cases: [string, string][] = [
    ["get():[string,(number|undefined)?];", "get():[string,number?]"],
    ["get():[string,number?];", "get():[string,(number|undefined)?]"],
    ["get():readonly [string,(number|undefined)?];", "get():ReadonlyOpt<number>"],
  ];
  for (const compiler of COMPILERS) for (const [design, signature] of cases) {
    assert.deepEqual(codes(project(t, compiler, design, service(signature), false)), [], `${compiler} ${design} / ${signature}`);
  }
});
