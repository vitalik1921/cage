import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { checkLinking, contract, data, designProject, mdx } from "./helpers.ts";

const compilers = ["typescript-5", "typescript"] as const;

/** One project per case: each contract has exactly one implementation, and the project uses the given compiler. */
function project(t: TestContext, compiler: string, designs: string[], source: string, files: Record<string, string> = {}) {
  const root = designProject(t, { m: mdx(...designs) }, { "src/m/impl.ts": source, ...files });
  fs.mkdirSync(path.join(root, "node_modules"));
  fs.symlinkSync(path.resolve("node_modules", compiler), path.join(root, "node_modules/typescript"), "dir");
  const result = checkLinking(root);
  assert.equal(result.typescript.version, compiler === "typescript-5" ? "5.9.3" : "6.0.3");
  return result;
}

const tree = data("Tree", "{value:string; next?:Tree}");
const box = data("Box", "{value:string; inner:{name:string}; next?:Box}");

/** @tests Cli
 * @covers exact-signatures */
test("a generic that grows against a fixed recursive type is proved equivalent for every argument on TS5/TS6", (t) => {
  const cases: Record<string, [string[], string]> = {
    "interface on the implementation side": [[data("Tree", "{next?:Tree}"), contract("Reader", "read():Tree;")],
      'interface Branch<T>{next?:Branch<T[]>}\n/** @implements Reader */\nexport class Reader {read():Branch<string>{return {}}}'],
    "alias with fixed leaves": [[tree, contract("Reader", "read():Tree;")],
      'type Branch<T>={value:string; next?:Branch<T[]>};\n/** @implements Reader */\nexport class Reader {read():Branch<string>{return {value:""}}}'],
    "call signature": [[data("Tree", "{next?:Tree}"), contract("Callable", "():Tree;")],
      'interface Branch<T>{next?:Branch<T[]>}\n/** @implements Callable */\nexport function read():Branch<string>{return {}}'],
    "design side grows": [[data("Tree<T>", "{next?:Tree<T[]>}"), contract("Reader", "read():Tree<string>;")],
      'type Plain={next?:Plain};\n/** @implements Reader */\nexport class Reader {read():Plain{return {}}}'],
    "parameter occurs in a recursive method": [[tree, contract("Reader", "read(): Tree;")],
      'interface Branch<T>{value:string; next?:Branch<Promise<T>>}\n/** @implements Reader */\nexport class Reader {read():Branch<number>{return {value:""}}}'],
  };
  for (const compiler of compilers) for (const [name, [designs, source]] of Object.entries(cases)) {
    const result = project(t, compiler, designs, source);
    assert.deepEqual(result.errors, [], `${compiler} ${name}`);
    assert.ok(result.linking.implementations.length === 1 && result.linking.implementations[0].compatible, `${compiler} ${name}`);
  }
});

/** @tests Cli
 * @covers exact-signatures */
test("a growing generic is not approved when its shape differs or depends on the argument on TS5/TS6", (t) => {
  const reader = contract("Reader", "read():Tree;");
  const cases: Record<string, string> = {
    // Assignable, but readonly and an extra nested member are part of the exact shape.
    "readonly leaf": 'interface Branch<T>{readonly value:string; next?:Branch<T[]>}',
    "extra member": 'interface Branch<T>{value:string; extra?:number; next?:Branch<T[]>}',
    // The argument is visible: value is string, then string[], ...
    "argument in a leaf": 'interface Branch<T>{value:T; next?:Branch<T[]>}',
    // Writable for string, readonly from the second level on: invisible to assignability.
    "argument made readonly": 'interface Branch<T>{value:string; inner:T; next?:Branch<Readonly<T>>}',
    "argument chooses readonly": 'type Branch<T>=(T extends string ? {value:string} : {readonly value:string}) & {next?:Branch<T[]>}',
    // Members contributed by the argument: none for {}, the array's members one level down.
    "intersection with the argument": 'type Branch<T extends object>={value:string; next?:Branch<T[]>} & T',
    "mapped over the argument": 'type Branch<T>={value:string; next?:Branch<T[]>} & {[K in keyof T]: string}',
  };
  for (const compiler of compilers) for (const [name, declaration] of Object.entries(cases)) {
    const argument = name === "argument made readonly" ? "{name:string}" : name.startsWith("argument") ? "string" : "{}";
    const designs = name === "argument made readonly" ? [box, contract("Reader", "read():Box;")] : [tree, reader];
    const result = project(t, compiler, designs, `${declaration}\n/** @implements Reader */\nexport class Reader {read():Branch<${argument}>{return {value:""} as Branch<${argument}>}}`);
    assert.equal(result.linking.implementations[0]?.compatible, false, `${compiler} ${name}`);
    assert.ok(result.errors.length > 0 && result.errors.every(d => ["E_TYPE_MISMATCH", "E_CONTRACT_SIGNATURE", "E_CONTRACT_UNCHECKABLE"].includes(d.code)), `${compiler} ${name}: ${JSON.stringify(result.errors)}`);
  }
});

/** @tests Cli
 * @covers exact-signatures */
test("a growing generic whose members inspect the argument still ends at the explicit guard on TS5/TS6", (t) => {
  // Equivalent at every depth, but only by evaluating the conditional for each argument: no proof for all.
  // The plain implementation of another contract is compared afterwards and must not inherit the guard.
  for (const compiler of compilers) {
    const result = project(t, compiler, [tree, contract("Reader", "read():Tree;"), contract("Writer", "read():Tree;")],
      'interface Branch<T>{value:T extends string ? string : string; next?:Branch<T[]>}\n/** @implements Reader */\nexport class Reader {read():Branch<string>{return {value:""}}}',
      { "src/m/z.ts": 'type Plain={value:string; next?:Plain};\n/** @implements Writer */\nexport class Writer {read():Plain{return {value:""}}}' });
    assert.equal(result.linking.implementations.find(i => i.name === "Reader")?.compatible, false, compiler);
    assert.equal(result.linking.implementations.find(i => i.name === "Writer")?.compatible, true, compiler);
    assert.equal(result.errors.length, 1, JSON.stringify(result.errors));
    assert.equal(result.errors[0].code, "E_CONTRACT_UNCHECKABLE", compiler);
    assert.match(result.errors[0].message, /comparison limit/, compiler);
  }
});
