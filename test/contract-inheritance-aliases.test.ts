import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { at, checkDesigns, checkLinking, cli, designProject, mdx } from "./helpers.ts";

const COMPILERS = ["typescript-5", "typescript"] as const;

function project(t: TestContext, compiler: string, designs: Record<string, string>, files: Record<string, string> = {}): string {
  const root = designProject(t, designs, files);
  fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
  fs.symlinkSync(path.resolve("node_modules", compiler), path.join(root, "node_modules/typescript"), "dir");
  return root;
}

const declare = (marker: "contract" | "data", name: string, head: string, ...tags: string[]) => ["/**", ` * @${marker}`, ` * @description ${name}.`, ...tags.map((tag) => ` * ${tag}`), " */", head].join("\n");
const data = (name: string, type: string) => declare("data", name, `export type ${name} = ${type};`);
const WRITER = declare("contract", "Writer", ["export interface Writer {", "  /** @invariant persists a written value is read back */", "  write(id: string, value: string): void;", "  readonly size: number;", "}"].join("\n"));
const STORE = (bases: string, body = "") => declare("contract", "Store", `export interface Store extends ${bases} {${body}}`);

/** @tests Cli
 * @covers contract-inheritance */
test("a @data alias that copies a contract's API without its declarations is rejected, wherever it is written", (t) => {
  const copies: { name: string; designs: Record<string, string>; module?: string; needle: string }[] = [
    { name: "Record of a member type", designs: { m: mdx(WRITER, data("Part", 'Record<"write", Writer["write"]>'), STORE("Part")) }, needle: 'Writer["write"]>' },
    { name: "a mapping over literal keys", designs: { m: mdx(WRITER, data("Part", '{ [K in "write"]: Writer[K] }'), STORE("Part")) }, needle: "Writer[K]" },
    { name: "a remapping of the keys", designs: { m: mdx(WRITER, data("Part", "{ [K in keyof Writer as `${K}`]: Writer[K] }"), STORE("Part")) }, needle: "Writer[K]" },
    { name: "a plain field of a member type", designs: { m: mdx(WRITER, data("Part", '{ write: Writer["write"] }'), STORE("Part")) }, needle: 'Writer["write"] }' },
    { name: "a property's type", designs: { m: mdx(WRITER, data("Part", '{ size: Writer["size"] }'), STORE("Part")) }, needle: 'Writer["size"]' },
    { name: "an alias chain", designs: { m: mdx(WRITER, data("Write", 'Writer["write"]'), data("Part", "{ write: Write }"), STORE("Part")) }, needle: 'Writer["write"];' },
    {
      name: "a generic mapped alias",
      designs: { m: mdx(WRITER, data("Copy<T, K extends keyof T>", "{ [P in K]: T[P] }"), data("Part", 'Copy<Writer, "write">'), STORE("Part")) },
      needle: "T[P]",
    },
    {
      name: "an imported alias",
      designs: {
        io: mdx(WRITER, data("Part", 'Record<"write", Writer["write"]>')),
        store: mdx('import type { Part } from "../io/io.cage.mdx";', STORE("Part")),
      },
      module: "io",
      needle: 'Writer["write"]>',
    },
    {
      name: "a namespace import of a mapped alias over an imported contract",
      designs: {
        io: mdx(WRITER),
        parts: mdx('import type { Writer } from "../io/io.cage.mdx";', data("Part", '{ [K in "write"]: Writer[K] }')),
        store: mdx('import type * as parts from "../parts/parts.cage.mdx";', STORE("parts.Part")),
      },
      module: "parts",
      needle: "Writer[K]",
    },
    {
      name: "a @data interface on the way",
      designs: { m: mdx(WRITER, data("Part", 'Record<"write", Writer["write"]>'), declare("data", "Mid", "export interface Mid extends Part {}"), STORE("Mid")) },
      needle: 'Writer["write"]>',
    },
    {
      name: "a transparent generic alias around a type parameter",
      designs: { m: mdx(WRITER, data("Id<T>", "T"), data("Part<T extends { write: unknown }>", 'Record<"write", Id<T>["write"]>'), STORE("Part<Writer>")) },
      needle: 'Id<T>["write"]',
    },
    {
      name: "a transparent generic alias imported from another design",
      designs: {
        util: mdx(data("Id<T>", "T")),
        store: mdx('import type { Id } from "../util/util.cage.mdx";', WRITER, data("Part<T extends { write: unknown }>", 'Record<"write", Id<T>["write"]>'), STORE("Part<Writer>")),
      },
      module: "store",
      needle: 'Id<T>["write"]',
    },
    {
      name: "transparent aliases over transparent aliases",
      designs: { m: mdx(WRITER, data("Id<T>", "T"), data("Same<T>", "Id<(Id<T>)>"), data("Part<T extends { write: unknown }>", '{ write: Same<T>["write"] }'), STORE("Part<Writer>")) },
      needle: 'Same<T>["write"]',
    },
    {
      name: "an alias of the contract itself",
      designs: { m: mdx(WRITER, data("Alias", "Writer"), data("Part", '{ write: Alias["write"] }'), STORE("Part")) },
      needle: 'Alias["write"]',
    },
    {
      name: "the copying member of a shape selected by its key",
      designs: { m: mdx(WRITER, data("Part", '{ value: { a: Writer["write"]; b: string }["a"] }'), STORE("Part")) },
      needle: 'Writer["write"]; b',
    },
    {
      name: "a union of keys that takes the copying member",
      designs: { m: mdx(WRITER, data("Part", '{ value: { a: Writer["write"]; b: string; c: number }["a" | "c"] }'), STORE("Part")) },
      needle: 'Writer["write"]; b',
    },
    {
      name: "a nested selection that ends at the copy",
      designs: { m: mdx(WRITER, data("Part", '{ value: { x: { a: Writer["write"]; b: string } }["x"]["a"] }'), STORE("Part")) },
      needle: 'Writer["write"]; b',
    },
    {
      name: "the copying member of a @data interface",
      designs: { m: mdx(WRITER, declare("data", "Shape", 'export interface Shape {\n  a: Writer["write"];\n  b: string;\n}'), data("Part", '{ value: Shape["a"] }'), STORE("Part")) },
      needle: 'Writer["write"];',
    },
    {
      name: "a key given to a generic alias through a transparent one",
      designs: { m: mdx(WRITER, data("Id<T>", "T"), data("Part<K extends \"a\" | \"b\">", '{ value: Id<{ a: Writer["write"]; b: string }>[K] }'), STORE('Part<"a">')) },
      needle: 'Writer["write"]; b',
    },
  ];
  for (const compiler of COMPILERS) {
    for (const { name, designs, needle, module = Object.keys(designs)[0] } of copies) {
      const root = project(t, compiler, designs);
      const { errors, index } = checkDesigns(root);
      assert.deepEqual(
        errors.map(({ code, message, file, line, column }) => ({ code, message, file, line, column })),
        [{ code: "E_UNSUPPORTED_DECLARATION", message: errors[0]?.message, ...at(root, module, needle) }],
        `${compiler}: ${name}`,
      );
      assert.match(errors[0].message, /^Store: `extends .*` copies the API of contract "Writer" without extending it; extend "Writer" so that its invariants come along$/, `${compiler}: ${name}`);
      // Not a contract quietly without the promise: the design is refused, and so is the check.
      assert.deepEqual(index.invariants.filter((invariant) => invariant.contract === "Store"), [], `${compiler}: ${name}`);
      assert.equal(cli(root, "check").code, 1, `${compiler}: ${name}`);
    }
  }
});

/** @tests Cli
 * @covers contract-inheritance */
test("a member whose origin cannot be told is an explicit error, not a pass", (t) => {
  const unknown: { name: string; blocks: string[]; needle: string }[] = [
    { name: "an inferred object indexed", blocks: [data("Part", 'Writer extends infer U extends { write: unknown } ? { write: U["write"] } : never')], needle: 'U["write"]' },
    { name: "an inferred member type", blocks: [data("Part", "Writer extends { write: infer W } ? { write: W } : never")], needle: "W } :" },
    // The boundary: an inferred member is unknown whatever it is inferred from, a contract or not.
    { name: "an inferred member of a plain shape", blocks: [data("Plain", "{ read(): void }"), data("Part", "Plain extends { read: infer R } ? { read: R } : never")], needle: "R } :" },
    // A conditional on the arguments of a generic alias is not decided here; a branch with a contract makes it unknown.
    { name: "a generic conditional with a contract in a branch", blocks: [data("Choose<T>", "T extends string ? Writer : { read(): void }")], needle: "T extends string" },
    // A key no argument gives (a mapped key) over a shape that holds a copy: which member is taken is not told.
    { name: "a key that is not known over a shape with a copy", blocks: [data("Part", '{ [P in "a" | "b"]: { a: Writer["write"]; b: string }[P] }')], needle: '{ a: Writer["write"]; b: string }[P]' },
  ];
  for (const compiler of COMPILERS) {
    for (const { name, blocks, needle } of unknown) {
      const store = name === "a generic conditional with a contract in a branch" ? STORE("Choose<number>") : STORE("Part");
      const root = project(t, compiler, { m: mdx(WRITER, ...blocks, store) });
      const { errors, index } = checkDesigns(root);
      assert.deepEqual(errors.map(({ code, file, line, column }) => ({ code, file, line, column })), [{ code: "E_UNSUPPORTED_DECLARATION", ...at(root, "m", needle) }], `${compiler}: ${name}`);
      assert.match(errors[0].message, /where a member of this base comes from cannot be told/, `${compiler}: ${name}`);
      assert.deepEqual(index.invariants.filter((invariant) => invariant.contract === "Store"), [], `${compiler}: ${name}`);
      assert.equal(cli(root, "check").code, 1, `${compiler}: ${name}`);
    }
  }
});

/** @tests Cli
 * @covers contract-inheritance */
test("holding a contract, reusing a shape, or extending the contract itself is not a copy of its API", (t) => {
  const accepted: { name: string; designs: Record<string, string>; members: string[]; invariants: string[] }[] = [
    { name: "a field of the contract's type", designs: { m: mdx(WRITER, declare("data", "Holder", "export interface Holder {\n  delegate: Writer;\n}"), STORE("Holder")) }, members: ["delegate"], invariants: [] },
    { name: "a generic field given the contract", designs: { m: mdx(WRITER, data("Box<T>", "{ value: T }"), STORE("Box<Writer>")) }, members: ["value"], invariants: [] },
    { name: "a field typed through a transparent alias", designs: { m: mdx(WRITER, data("Id<T>", "T"), data("Holder<T>", "{ delegate: Id<T> }"), STORE("Holder<Writer>")) }, members: ["delegate"], invariants: [] },
    {
      name: "a member of a shape given through a transparent alias",
      designs: { m: mdx(WRITER, data("Id<T>", "T"), data("Part<T extends { write: unknown }>", 'Record<"write", Id<T>["write"]>'), STORE("Part<{ write: (id: string) => void }>")) },
      members: ["write"],
      invariants: [],
    },
    { name: "a nested field of a member type", designs: { m: mdx(WRITER, data("Holder", '{ nested: { write: Writer["write"] } }'), STORE("Holder")) }, members: ["nested"], invariants: [] },
    {
      name: "a type parameter that has the contract's name",
      designs: { m: mdx(WRITER, data("Wrap<Writer extends { write: unknown }>", '{ write: Writer["write"] }'), STORE("Wrap<{ write: (id: string) => void }>")) },
      members: ["write"],
      invariants: [],
    },
    {
      name: "an imported @data of the contract's name",
      designs: {
        io: mdx(declare("data", "Writer", "export interface Writer {\n  write(id: string, value: string): void;\n}")),
        store: mdx('import type { Writer as Plain } from "../io/io.cage.mdx";', data("Part", 'Record<"write", Plain["write"]>'), STORE("Part")),
      },
      members: ["write"],
      invariants: [],
    },
    { name: "a reusable shape of no contract", designs: { m: mdx(WRITER, data("Part", 'Record<"read", (id: string) => string>'), STORE("Part")) }, members: ["read"], invariants: [] },
    { name: "a contract in the branch the compiler does not take", designs: { m: mdx(WRITER, data("Part", "string extends number ? Writer : { read(): void }"), STORE("Part")) }, members: ["read"], invariants: [] },
    { name: "a contract in the false branch of a true condition", designs: { m: mdx(WRITER, data("Part", "true extends true ? { read(): void } : Writer"), STORE("Part")) }, members: ["read"], invariants: [] },
    { name: "a decided conditional over a copy in the dead branch", designs: { m: mdx(WRITER, data("Part", '1 extends 2 ? { write: Writer["write"] } : { read(): void }'), STORE("Part")) }, members: ["read"], invariants: [] },
    { name: "a generic conditional whose branches hand on no contract", designs: { m: mdx(WRITER, data("Either<T>", "T extends string ? { read(): void } : { read(): void; delegate: Writer }"), STORE("Either<number>")) }, members: ["read", "delegate"], invariants: [] },
    { name: "the keys of a mapped type", designs: { m: mdx(WRITER, data("Keys", '{ [K in "a" | "b"]: K }'), STORE("Keys")) }, members: ["a", "b"], invariants: [] },
    { name: "a member of a shape beside a copy, selected by its key", designs: { m: mdx(WRITER, data("Part", '{ value: { a: Writer["write"]; b: string }["b"] }'), STORE("Part")) }, members: ["value"], invariants: [] },
    { name: "a union of keys that leaves the copy out", designs: { m: mdx(WRITER, data("Part", '{ value: { a: Writer["write"]; b: string; c: number }["b" | "c"] }'), STORE("Part")) }, members: ["value"], invariants: [] },
    { name: "a nested selection beside the copy", designs: { m: mdx(WRITER, data("Part", '{ value: { x: { a: Writer["write"]; b: string } }["x"]["b"] }'), STORE("Part")) }, members: ["value"], invariants: [] },
    {
      name: "a member of a @data interface beside a copy",
      designs: { m: mdx(WRITER, declare("data", "Shape", 'export interface Shape {\n  a: Writer["write"];\n  b: string;\n}'), data("Part", '{ value: Shape["b"] }'), STORE("Part")) },
      members: ["value"],
      invariants: [],
    },
    {
      name: "a shape through a local transparent alias, selected by its key",
      designs: { m: mdx(WRITER, data("Id<T>", "T"), data("Shape", '{ a: Writer["write"]; b: string }'), data("Part", '{ value: Id<Shape>["b"] }'), STORE("Part")) },
      members: ["value"],
      invariants: [],
    },
    {
      name: "a key given to a generic alias through a transparent one, beside the copy",
      designs: { m: mdx(WRITER, data("Id<T>", "T"), data("Part<K extends \"a\" | \"b\">", '{ value: Id<{ a: Writer["write"]; b: string }>[K] }'), STORE('Part<"b">')) },
      members: ["value"],
      invariants: [],
    },
    {
      name: "the copying member selected, its contract extended",
      designs: { m: mdx(WRITER, data("Part", '{ value: { a: Writer["write"]; b: string }["a"] }'), STORE("Writer, Part")) },
      members: ["write", "size", "value"],
      invariants: ["persists"],
    },
    {
      name: "the contract extended, a copy of its types beside it",
      designs: { m: mdx(WRITER, data("Part", 'Record<"write", Writer["write"]>'), STORE("Writer, Part")) },
      members: ["write", "size"],
      invariants: ["persists"],
    },
    {
      name: "the contract reached along a @data interface's extends",
      designs: { m: mdx(WRITER, declare("data", "Mid", "export interface Mid extends Writer {}"), STORE("Mid")) },
      members: ["write", "size"],
      invariants: ["persists"],
    },
  ];
  for (const compiler of COMPILERS) {
    for (const { name, designs, members, invariants } of accepted) {
      const root = project(t, compiler, designs);
      const { errors, index } = checkDesigns(root);
      assert.deepEqual(errors, [], `${compiler}: ${name}`);
      const store = index.contracts.find((contract) => contract.name === "Store")!;
      assert.deepEqual(store.members.map((member) => member.name), members, `${compiler}: ${name}`);
      assert.deepEqual(index.invariants.filter((invariant) => invariant.contract === "Store").map((invariant) => invariant.id), invariants, `${compiler}: ${name}`);
    }
  }
});

/** @tests Cli
 * @covers contract-inheritance */
test("a contract that extends the contract it reuses types of carries its promise into implementation and tests", (t) => {
  const tests = (contract: string) =>
    [`import { describe, test } from "node:test";`, `/** @tests ${contract} */`, `describe("${contract}", () => {`, "  /** @covers persists */", '  test("persists", () => { if (1 + 1 !== 2) throw new Error("persists"); });', "});", ""].join("\n");
  const impl = (name: string, contract: string) =>
    `/** @implements ${contract} */\nexport class ${name} { readonly size: number = 0; write(id: string, value: string): void {} }\n`;
  for (const compiler of COMPILERS) {
    const root = project(t, compiler, { m: mdx(WRITER, data("Part", 'Record<"write", Writer["write"]>'), STORE("Writer, Part")) }, {
      "src/m/writer.ts": impl("MemoryWriter", "Writer"),
      "src/m/store.ts": impl("MemoryStore", "Store"),
      "src/m/writer.test.ts": tests("Writer"),
      "src/m/store.test.ts": tests("Store"),
    });
    assert.deepEqual(checkLinking(root).errors, [], compiler);
    assert.equal(cli(root, "check").code, 0, compiler);
    // Without the test of the inherited promise the derived contract is incomplete.
    fs.rmSync(path.join(root, "src/m/store.test.ts"));
    const missing = checkLinking(root).errors.find((error) => error.code === "E_TEST_MISSING");
    assert.deepEqual(missing && [missing.contract, missing.invariant], ["Store", "persists"], compiler);
  }
});
