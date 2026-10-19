import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { checkLinking, contract, designProject, mdx, cli, writeFile } from "./helpers.ts";

// Regressions found by an independent review, exercised with both supported compilers.
function projects(t: TestContext, body: string, source: string) {
  return ["typescript-5", "typescript"].map(compiler => {
    const root = designProject(t, { m: mdx(contract("Port", body)) }, { "src/m/impl.ts": source });
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.symlinkSync(path.resolve("node_modules", compiler), path.join(root, "node_modules/typescript"), "dir");
    return root;
  });
}

/** @tests Cli
 * @covers exact-signatures */
test("intersection setters must not approve an unwritable promised field", t => {
  const roots = projects(t, "get():{value:string};", 'type A={get value():string;set value(x:string)};type B={get value():string;set value(x:number)};\n/** @implements Port */\nexport class Service {get():A&B{throw 1}}');
  assert.deepEqual(roots.map(root => checkLinking(root).errors.length > 0), [true, true]);
});

test("named local exports require design coverage just like direct exports", t => {
  const roots = projects(t, "run():void;", '/** @implements Port */\nexport class Service {run():void{}}\nclass Extra {extra():void{}}\nexport {Extra};');
  for (const root of roots) writeFile(root, ".cage/config.json", JSON.stringify({ version: 1, coverage: "require", review: "off" }));
  assert.deepEqual(roots.map(root => cli(root, "check").code), [1, 1]);
});

/** @tests Cli
 * @covers exact-signatures */
test("mapped fields stay ordinary fields inside intersections", t => {
  const roots = projects(t, "value?:string;tag:string;", 'class Box<T>{get value():string{return ""}set value(x:T){}}\n/** @implements Port */\nexport const service:Partial<Box<number>>&{tag:string}={tag:""};');
  assert.deepEqual(roots.map(root => checkLinking(root).errors), [[], []]);
});

/** @tests Cli
 * @covers exact-signatures */
test("renamed generic conditional callbacks preserve equivalent signatures", t => {
  const roots = projects(t, "fn:<T>(x:T)=>T extends string?1:2;", '/** @implements Port */\nexport const service={fn:<U>(x:U):U extends string?1:2=>{throw 1}};');
  assert.deepEqual(roots.map(root => checkLinking(root).errors), [[], []]);
});

/** @tests Cli
 * @covers exact-signatures */
test("identical labelled tuples preserve equivalent signatures", t => {
  const roots = projects(t, "get():[count:number,name:string];", '/** @implements Port */\nexport class Service {get():[count:number,name:string]{throw 1}}');
  assert.deepEqual(roots.map(root => checkLinking(root).errors), [[], []]);
});
