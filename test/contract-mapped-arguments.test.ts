import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { checkLinking, contract, designProject, mdx, PROJECT_OPTIONS, writeFile } from "./helpers.ts";

const compilers = ["typescript-5", "typescript"] as const;

/** Mapped declarations shared by design and implementation through one package; their instances carry no alias. */
const LIBRARY = [
  "type Id<T> = T;",
  'export type Box<T> = Id<{ [K in "a"]: T }>;',
  'export type OptionalBox<T> = Id<{ [K in "a"]?: T }>;',
  "export type Flat<T> = Id<{ [k in keyof T]: T[k] }>;",
  "export declare class Holder<T> { get<U>(value: U): Flat<{ a?: T; u: U }>; }",
  'export declare class Picker { get<U extends { a: string }>(u: U): Flat<{ a: U["a"] }>; }',
  'export declare class WidePicker { get<U extends { a: string }>(u: U): Flat<{ a: U["a"]; b: string }>; }',
  "export declare function make<T>(): T;",
  "export declare class Bound<X> { f<B extends X>(b: B): B; }",
  "export declare class Base<O> { g<R extends O>(r: R): R; }",
  "export declare class Derived<S> extends Base<S[]> { h<K extends { [k: string]: S }>(k: K): K; }",
  "",
].join("\n");

function project(t: TestContext, compiler: string, exactOptional: boolean, design: string, implementation: string) {
  const root = designProject(t, { m: mdx(design) }, { "src/m/impl.ts": implementation });
  writeFile(root, "tsconfig.json", JSON.stringify({ compilerOptions: { ...PROJECT_OPTIONS, exactOptionalPropertyTypes: exactOptional } }));
  writeFile(root, "node_modules/lib/package.json", JSON.stringify({ name: "lib", version: "1.0.0", types: "./index.d.ts" }));
  writeFile(root, "node_modules/lib/index.d.ts", LIBRARY);
  fs.symlinkSync(path.resolve("node_modules", compiler), path.join(root, "node_modules/typescript"), "dir");
  const result = checkLinking(root);
  assert.equal(result.typescript.version, compiler === "typescript-5" ? "5.9.3" : "6.0.3");
  return result;
}

const reader = (type: string) => `import type { Box, OptionalBox } from "lib";\n${contract("Reader", `get(): ${type};`)}`;
const readerImpl = (type: string) => `import type { Box, OptionalBox } from "lib";\n/** @implements Reader */\nexport class Reader { get(): ${type} { return { a: "" }; } }\n`;

/** @tests Cli
 * @covers exact-signatures */
test("instances of a shared mapped declaration compare their arguments without dropping undefined, on TS5/TS6", (t) => {
  // [design, implementation, equal without exactOptionalPropertyTypes, equal with it]
  const cases: Record<string, [string, string, boolean, boolean]> = {
    "required, same argument": ["Box<string | undefined>", "Box<string | undefined>", true, true],
    "required, undefined dropped": ["Box<string | undefined>", "Box<string>", false, false],
    "required, undefined added": ["Box<string>", "Box<string | undefined>", false, false],
    "optional, same argument": ["OptionalBox<string>", "OptionalBox<string>", true, true],
    // Without exactOptionalPropertyTypes `a?: string` already accepts undefined: the two instances are one type.
    "optional, undefined dropped": ["OptionalBox<string | undefined>", "OptionalBox<string>", true, false],
    // The compiler itself rejects this one, comparing the alias arguments by their measured variance.
    "optional, undefined added": ["OptionalBox<string>", "OptionalBox<string | undefined>", false, false],
  };
  for (const compiler of compilers) for (const exactOptional of [false, true]) for (const [name, [design, actual, plain, exact]] of Object.entries(cases)) {
    const label = `${compiler} exactOptional=${exactOptional} ${name}`;
    const result = project(t, compiler, exactOptional, reader(design), readerImpl(actual));
    const expected = exactOptional ? exact : plain;
    assert.equal(result.linking.implementations[0]?.compatible, expected, `${label}: ${JSON.stringify(result.errors.map(d => d.code + " " + d.message.split("\n")[0]))}`);
    if (!expected) assert.ok(result.errors.length && result.errors.every(d => d.code === "E_TYPE_MISMATCH" || d.code === "E_CONTRACT_SIGNATURE"), `${label}: ${JSON.stringify(result.errors)}`);
  }
});

/** @tests Cli
 * @covers exact-signatures */
test("generic instances of a shared mapped declaration recover the whole argument behind an optional member, on TS5/TS6", (t) => {
  const design = (argument: string) => `import type { Holder } from "lib";\n/**\n * @contract\n * @description Store.\n */\nexport interface Store extends Holder<${argument}> {}`;
  const implementation = (argument: string) => `import { make, type Holder } from "lib";\n/** @implements Store */\nexport const store = make<Holder<${argument}>>();\n`;
  const cases: Record<string, [string, string, boolean, boolean]> = {
    same: ["string | undefined", "string | undefined", true, true],
    "undefined dropped": ["string | undefined", "string", true, false],
    different: ["string", "number", false, false],
  };
  for (const compiler of compilers) for (const exactOptional of [false, true]) for (const [name, [expectedArgument, actualArgument, plain, exact]] of Object.entries(cases)) {
    const label = `${compiler} exactOptional=${exactOptional} ${name}`;
    const result = project(t, compiler, exactOptional, design(expectedArgument), implementation(actualArgument));
    const expected = exactOptional ? exact : plain;
    assert.equal(result.linking.implementations[0]?.compatible, expected, `${label}: ${JSON.stringify(result.errors.map(d => d.code + " " + d.message.split("\n")[0]))}`);
  }
});

/** @tests Cli
 * @covers exact-signatures */
test("an optional member's written undefined and the missing marker differ only under exactOptionalPropertyTypes, on TS5/TS6", (t) => {
  for (const compiler of compilers) for (const exactOptional of [false, true]) {
    const result = project(t, compiler, exactOptional, contract("Reader", "get(): { a?: string | undefined };"),
      "/** @implements Reader */\nexport class Reader { get(): { a?: string } { return {}; } }\n");
    assert.equal(result.linking.implementations[0]?.compatible, !exactOptional, `${compiler} exactOptional=${exactOptional}: ${JSON.stringify(result.errors.map(d => d.code + " " + d.message.split("\n")[0]))}`);
  }
});

/** @tests Cli
 * @covers exact-signatures */
test("an indexed access in a resolved mapped instance is no argument of it, on TS5/TS6", (t) => {
  // Flat<{ a: U["a"] }> is resolved: its member reads U["a"], but its argument is { a: U["a"] }, not U.
  const design = 'import type { Picker } from "lib";\n/**\n * @contract\n * @description Store.\n */\nexport interface Store extends Picker {}';
  for (const compiler of compilers) for (const [name, type, expected] of [["same", "Picker", true], ["extra key", "WidePicker", false]] as const) {
    const result = project(t, compiler, false, design, `import { make, type ${type} } from "lib";\n/** @implements Store */\nexport const store = make<${type}>();\n`);
    assert.equal(result.linking.implementations[0]?.compatible, expected, `${compiler} ${name}: ${JSON.stringify(result.errors.map(d => d.code + " " + d.message.split("\n")[0]))}`);
  }
});

/** @tests Cli
 * @covers exact-signatures */
test("a method's constraint on its owner's parameters is read through the owner's arguments and bases, on TS5/TS6", (t) => {
  const design = (base: string) => `import type { Bound, Derived } from "lib";\n/**\n * @contract\n * @description Store.\n */\nexport interface Store extends ${base} {}`;
  const implementation = (type: string) => `import { make, type Bound, type Derived } from "lib";\n/** @implements Store */\nexport const store = make<${type}>();\n`;
  // [design base, implementation type, equal]
  const cases: Record<string, [string, string, boolean]> = {
    "class argument": ["Bound<string>", "Bound<string>", true],
    "different class argument": ["Bound<string>", "Bound<number>", false],
    // g's R extends O, O = S[] through Derived's base; h's constraint is an object naming S.
    "base chain": ["Derived<string>", "Derived<string>", true],
    "different base chain": ["Derived<string>", "Derived<string | undefined>", false],
  };
  for (const compiler of compilers) for (const [name, [base, type, expected]] of Object.entries(cases)) {
    const result = project(t, compiler, false, design(base), implementation(type));
    const label = `${compiler} ${name}: ${JSON.stringify(result.errors.map(d => d.code + " " + d.message.split("\n")[0]))}`;
    assert.equal(result.linking.implementations[0]?.compatible, expected, label);
    // Equal owner arguments prove one constraint; unequal ones are never substituted into it, so it stays unchecked.
    if (expected) assert.deepEqual(result.errors, [], label);
    else assert.ok(result.errors.length, label);
  }
});
