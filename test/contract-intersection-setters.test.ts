import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { loadTypeScript } from "../src/typescript.ts";
import { checkLinking, contract, designProject, mdx } from "./helpers.ts";

const header = 'type A={get value():string;set value(x:string)};type B={get value():string;set value(x:number)};type Same={get value():string;set value(x:string)};' +
  'type Wide={get value():string;set value(x:string|number)};type LitAB={get value():"b";set value(x:"a"|"b")};type LitBC={get value():"b";set value(x:"b"|"c")};' +
  'type O1={get value():string;set value(x:{a:string})};type O2={get value():string;set value(x:{a:string;b?:number})};' +
  'class Box<T>{get value():string{return ""}set value(x:T){}} class Base<T>{get value():string{return ""}set value(x:T){}} class Child extends Base<string>{}\n';
// Each contract has exactly one implementation: true conforms, false is a signature mismatch, "uncheckable" cannot be proved.
const cases = [
  ["AB", "get():A&B{throw 1}", false],
  ["BA", "get():B&A{throw 1}", false],
  ["SharedOwner", "get():Box<string>&Box<number>{throw 1}", false],
  ["SharedOwnerSwapped", "get():Box<number>&Box<string>{throw 1}", false],
  ["InheritedMixed", "get():Child&B{throw 1}", false],
  ["WideNumber", "get():B&Wide{throw 1}", false],
  ["SharedWideNumber", "get():Box<number>&Box<string|number>{throw 1}", false],
  ["Equivalent", "get():A&Same{throw 1}", true],
  ["SharedEquivalent", "get():Box<string>&Box<string>{throw 1}", true],
  ["Inherited", "get():Child&Same{throw 1}", true],
  ["Fields", "get():{value:string}&{value:string}{throw 1}", true],
  ["Widened", "get():A&Wide{throw 1}", true],
  ["WidenedSwapped", "get():Wide&A{throw 1}", true],
  ["SharedWidened", "get():Box<string|number>&Box<string>{throw 1}", true],
  ["InheritedWidened", "get():Wide&Child{throw 1}", true],
  ["Literals", "get():LitAB&LitBC{throw 1}", true, "get():{value:\"b\"};"],
  ["LiteralsWrong", "get():LitAB&LitBC{throw 1}", false, 'get():{get value():"b";set value(x:"a"|"b")};'],
  ["Objects", "get():O1&O2{throw 1}", "uncheckable"],
] as const;

/** @tests Cli
 * @covers exact-signatures */
test("intersection setters compare the effective input domain with each constituent's own substitutions on TS5/TS6", (t) => {
  for (const compiler of ["typescript-5", "typescript"]) {
    const root = designProject(t, { m: mdx(...cases.map(([name, , , port]) => contract(`${name}Port`, port ?? "get():{value:string};"))) },
      Object.fromEntries(cases.map(([name, body]) => [`src/m/${name}.ts`, `${header}/** @implements ${name}Port */\nexport class ${name} {${body}}`])));
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.symlinkSync(path.resolve("node_modules", compiler), path.join(root, "node_modules/typescript"), "dir");
    const result = checkLinking(root);
    for (const [name, , expected] of cases) {
      const errors = result.errors.filter(d => d.file?.endsWith(`/${name}.ts`)), detail = `${compiler} ${name}: ${JSON.stringify(errors)}`;
      assert.equal(result.linking.implementations.find(i => i.name === name)?.compatible, expected === true, detail);
      if (expected === "uncheckable") assert.deepEqual(errors.map(d => d.code), ["E_CONTRACT_UNCHECKABLE"], detail);
      if (expected === false) assert.ok(errors.length > 0 && errors.every(d => d.code === "E_CONTRACT_SIGNATURE" || d.code === "E_TYPE_MISMATCH"), detail);
    }
  }
});

/** @tests Cli
 * @covers exact-signatures */
test("the compiler itself accepts only the composed setter domain on TS5/TS6", (t) => {
  for (const compiler of ["typescript-5", "typescript"]) {
    const root = designProject(t, {});
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.symlinkSync(path.resolve("node_modules", compiler), path.join(root, "node_modules/typescript"), "dir");
    const { ts, info } = loadTypeScript(root);
    assert.equal(info.source, "project", compiler);
    // Independent of cage: which writes a strict program accepts on the intersections themselves.
    const writes = [["A&Wide", '"s"', true], ["Wide&A", '"s"', true], ["A&Wide", "1", false], ["Wide&A", "1", false], ["LitAB&LitBC", '"b"', true], ["LitAB&LitBC", '"a"', false], ["A&B", '"s"', false]] as const;
    const source = header + writes.map(([type, value], i) => `declare const v${i}:${type};v${i}.value=${value};`).join("\n") + '\ndeclare const w:A&Wide;const port:{value:string}=w;';
    const file = path.join(root, "probe.ts"), host = ts.createCompilerHost({}), read = host.getSourceFile;
    host.getSourceFile = (name, ...rest) => name === file ? ts.createSourceFile(name, source, ts.ScriptTarget.ES2022) : read(name, ...rest);
    const program = ts.createProgram([file], { strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, lib: ["lib.es2022.d.ts"], types: [] }, host);
    const lines = new Set(ts.getPreEmitDiagnostics(program).map(d => d.file?.fileName === file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line : -1));
    writes.forEach(([type, value, accepted], i) => assert.equal(!lines.has(i + 1), accepted, `${info.version} ${type} = ${value}`));
    assert.ok(!lines.has(writes.length + 1) && lines.size === writes.filter(w => !w[2]).length, `${info.version} ${[...lines]}`);
  }
});
