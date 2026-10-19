import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { checkLinking, contract, designProject, mdx } from "./helpers.ts";

// C has a genuine setter wider than its getter; Id<C> turns it into an ordinary field that writes only string.
const TYPES = [
  'class C {get x():string{return ""}set x(v:string|number){}}',
  "type Id<T>={[K in keyof T]:T[K]};",
  "interface I extends Id<C> {}",
  "interface J extends I {}",
  "interface K extends J {}",
  "interface G<T> extends Id<C> {}",
  "interface D extends C {}",
  "interface E extends D {}",
  "interface O extends I {get x():string;set x(v:string|number)}",
  "interface P extends O {}",
].join("\n");
const SETTER = "get():{get x():string;set x(v:string|number)};";
const FIELD = "get():{x:string};";

// One project per compiler: the TypeScript 5 test install and the bundled TypeScript 6.
function compatible(t: TestContext, body: string, returned: string): boolean[] {
  return ["typescript-5", "typescript"].map(compiler => {
    const source = `${TYPES}\n/** @implements Port */\nexport class Service {get():${returned}{throw 1}}`;
    const root = designProject(t, { m: mdx(contract("Port", body)) }, { "src/m/impl.ts": source });
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.symlinkSync(path.resolve("node_modules", compiler), path.join(root, "node_modules/typescript"), "dir");
    const result = checkLinking(root);
    const found = result.linking.implementations.find(i => i.name === "Service");
    assert.ok(found, `${compiler}: Service is linked`);
    assert.ok(result.errors.every(error => error.code === "E_CONTRACT_SIGNATURE" || error.code === "E_TYPE_MISMATCH"), `${compiler}: ${JSON.stringify(result.errors)}`);
    return found.compatible === true && result.errors.length === 0;
  });
}

/** @tests Cli
 * @covers exact-signatures */
test("members inherited from a mapped base are ordinary fields, through several levels", t => {
  for (const returned of ["I", "J", "K", "G<number>", "Id<C>"]) {
    assert.deepEqual(compatible(t, SETTER, returned), [false, false], `${returned} against a setter`);
    assert.deepEqual(compatible(t, FIELD, returned), [true, true], `${returned} against a field`);
  }
});

/** @tests Cli
 * @covers exact-signatures */
test("setters inherited directly or redeclared over a mapped base stay setters", t => {
  for (const returned of ["C", "D", "E", "O", "P"]) {
    assert.deepEqual(compatible(t, SETTER, returned), [true, true], `${returned} against a setter`);
    assert.deepEqual(compatible(t, FIELD, returned), [false, false], `${returned} against a field`);
  }
});
