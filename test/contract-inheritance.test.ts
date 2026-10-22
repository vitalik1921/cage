import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { createRequire } from "node:module";
import type ts from "typescript";
import type { CheckReport } from "../src/check.ts";
import { resolveInheritance } from "../src/contract-inheritance.ts";
import { indexDesigns, type DesignSourceFile } from "../src/design-index.ts";
import { at, checkDesigns, checkLinking, cli, designFile, designProject, editFile, find, mdx, readFile, scratchDirectory, writeFile } from "./helpers.ts";

const COMPILERS = ["typescript-5", "typescript"] as const;

/** A design project that loads the given compiler as its own. */
function project(t: TestContext, compiler: string, designs: Record<string, string>, files: Record<string, string> = {}): string {
  const root = designProject(t, designs, files);
  fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
  fs.symlinkSync(path.resolve("node_modules", compiler), path.join(root, "node_modules/typescript"), "dir");
  return root;
}

const declaration = (marker: "contract" | "data", name: string, head: string, body: string[], ...tags: string[]) =>
  ["/**", ` * @${marker}`, ` * @description ${name}.`, ...tags.map((tag) => ` * ${tag}`), " */", `export interface ${head} {`, ...body.map((line) => `  ${line}`), "}"].join("\n");

const READER = declaration("data", "Reader", "Reader", ["read(id: string): string | undefined;", "readonly size: number;"]);
const WRITER = declaration("contract", "Writer", "Writer", ["/**", " * @description Stores a value.", " * @invariant persists a written value is read back", " */", "write(id: string, value: string): void;"]);
const STORE = declaration("contract", "Store", "Store extends Reader, Writer", [], "@invariant counts size counts the stored ids");

const WRITER_IMPL = "/** @implements Writer */\nexport class MemoryWriter { write(id: string, value: string): void {} }\n";
const STORE_IMPL = [
  "/** @implements Store */",
  "export class MemoryStore {",
  "  #values = new Map<string, string>();",
  "  get size(): number { return this.#values.size; }",
  "  read(id: string): string | undefined { return this.#values.get(id); }",
  "  write(id: string, value: string): void { this.#values.set(id, value); }",
  "}",
  "",
].join("\n");
const testsOf = (contract: string, ...ids: string[]) =>
  [`import { describe, test } from "node:test";`, `/** @tests ${contract} */`, `describe("${contract}", () => {`, ...ids.map((id) => `  /** @covers ${id} */\n  test("${id}", () => { if (1 + 1 !== 2) throw new Error("${id}"); });`), "});", ""].join("\n");

const STORE_FILES = {
  "src/store/writer.ts": WRITER_IMPL,
  "src/store/store.ts": STORE_IMPL,
  "src/store/writer.test.ts": testsOf("Writer", "persists"),
  "src/store/store.test.ts": testsOf("Store", "counts", "persists"),
};

function check(root: string): { code: number; report: CheckReport } {
  const { code, stdout } = cli(root, "check", "--format", "json", "--max-diagnostics", "all");
  return { code, report: JSON.parse(stdout) };
}
/** Position of the first `needle` after `anchor` in a module's document, computed from the text. */
function after(root: string, module: string, anchor: string, needle: string) {
  const text = readFile(root, designFile(module));
  const offset = text.indexOf(needle, text.indexOf(anchor));
  assert.ok(text.indexOf(anchor) >= 0 && offset >= 0, `${needle} after ${anchor}`);
  const lines = text.slice(0, offset).split("\n");
  return { file: designFile(module), line: lines.length, column: lines.at(-1)!.length + 1 };
}
const codes = (diagnostics: readonly { code: string }[]) => diagnostics.map(({ code }) => code);

/** @tests Cli
 * @covers contract-inheritance */
test("a contract extends local @data and @contract bases: resolved members, modifiers, invariants with their origin", (t) => {
  for (const compiler of COMPILERS) {
    const root = project(t, compiler, { store: mdx(READER, WRITER, STORE) }, STORE_FILES);
    const result = checkLinking(root);
    assert.deepEqual(result.errors, [], compiler);
    assert.equal(result.typescript.version, compiler === "typescript-5" ? "5.9.3" : "6.0.3");
    const store = result.index!.contracts.find((contract) => contract.name === "Store")!;
    assert.equal(store.shape, "object");
    assert.deepEqual(store.bases, [{ name: "Reader", module: "src/store", kind: "data" }, { name: "Writer", module: "src/store", kind: "contract" }]);
    assert.deepEqual(
      store.members.map(({ name, description, location, inheritedFrom }) => ({ name, description, location, inheritedFrom })),
      [
        { name: "read", description: null, location: at(root, "store", "read(id"), inheritedFrom: { name: "Reader", module: "src/store", kind: "data" } },
        { name: "size", description: null, location: at(root, "store", "readonly size"), inheritedFrom: { name: "Reader", module: "src/store", kind: "data" } },
        { name: "write", description: "Stores a value.", location: at(root, "store", "write(id"), inheritedFrom: { name: "Writer", module: "src/store", kind: "contract" } },
      ],
    );
    const invariants = result.index!.invariants.filter((invariant) => invariant.contract === "Store");
    assert.deepEqual(invariants.map(({ id, member, inheritedFrom, location }) => ({ id, member, inheritedFrom, location })), [
      { id: "counts", member: null, inheritedFrom: undefined, location: at(root, "store", "@invariant counts") },
      { id: "persists", member: "write", inheritedFrom: { contract: "Writer", module: "src/store" }, location: at(root, "store", "@invariant persists") },
    ]);
    // The base contract keeps its own promise and still needs its own implementation and tests.
    assert.deepEqual(result.index!.invariants.filter((invariant) => invariant.contract === "Writer").map(({ id }) => id), ["persists"]);
    const packet = JSON.parse(cli(root, "review", "Store", "--format", "json").stdout);
    assert.deepEqual(packet.contracts[0].invariants.find((invariant: { id: string }) => invariant.id === "persists").inheritedFrom, { contract: "Writer", module: "src/store" });
    assert.match(cli(root, "review", "Store").stdout, /persists.*inherited from Writer/);
    assert.deepEqual(
      result.index!.edges.filter((edge) => edge.kind === "extends").map(({ from, to, location }) => ({ from, to, location })),
      [
        { from: "Store", to: "Reader", location: at(root, "store", "Reader, Writer") },
        { from: "Store", to: "Writer", location: at(root, "store", "Reader, Writer", "Reader, ".length) },
      ],
    );
    assert.ok(!result.warnings.some((warning) => warning.code === "W_NO_INVARIANTS"));
    assert.equal(cli(root, "check").code, 0, compiler);
  }
});

/** @tests Cli
 * @covers contract-inheritance */
test("an inherited modifier, member or invariant is required of the derived implementation and tests", (t) => {
  for (const compiler of COMPILERS) {
    const root = project(t, compiler, { store: mdx(READER, WRITER, STORE) }, {
      ...STORE_FILES,
      "src/store/store.ts": STORE_IMPL.replace("  get size(): number { return this.#values.size; }\n", "  size = 0;\n"),
      "src/store/store.test.ts": testsOf("Store", "counts"),
    });
    const { errors } = checkLinking(root);
    const signature = errors.find((error) => error.code === "E_CONTRACT_SIGNATURE");
    assert.ok(signature?.message.includes("readonly size: number"), compiler);
    const missing = errors.find((error) => error.code === "E_TEST_MISSING");
    assert.deepEqual(missing && { contract: missing.contract, invariant: missing.invariant, file: missing.file, line: missing.line }, {
      contract: "Store",
      invariant: "persists",
      ...(({ file, line }) => ({ file, line }))(at(root, "store", "@invariant persists")),
    }, compiler);

    writeFile(root, "src/store/store.ts", STORE_IMPL.replace(/ {2}write\(.*\n/, ""));
    assert.ok(checkLinking(root).errors.some((error) => error.code === "E_TYPE_MISMATCH" && error.contract === "Store"), compiler);
    // The base contract is not implemented by the derived one.
    fs.rmSync(path.join(root, "src/store/writer.ts"));
    writeFile(root, "src/store/store.ts", STORE_IMPL);
    assert.ok(checkLinking(root).errors.some((error) => error.code === "E_IMPLEMENTATION_MISSING" && error.contract === "Writer"), compiler);
  }
});

/** @tests Cli
 * @covers contract-inheritance */
test("bases may be imported by name or through a namespace, and an empty body takes the whole API", (t) => {
  for (const compiler of COMPILERS) {
    const io = mdx(READER, WRITER);
    const named = mdx(['import type { Reader, Writer as Out } from "../io/io.cage.mdx";'].join("\n"), declaration("contract", "Store", "Store extends Reader, Out", []));
    const root = project(t, compiler, { io, store: named });
    const { errors, index, diagnostics } = checkDesigns(root);
    assert.deepEqual(errors, [], compiler);
    const store = index.contracts.find((contract) => contract.name === "Store")!;
    assert.deepEqual(store.members.map(({ name, inheritedFrom, location }) => [name, inheritedFrom?.name, location.file]), [
      ["read", "Reader", designFile("io")],
      ["size", "Reader", designFile("io")],
      ["write", "Writer", designFile("io")],
    ]);
    assert.deepEqual(index.invariants.filter((invariant) => invariant.contract === "Store").map(({ id, location }) => [id, location]), [["persists", at(root, "io", "@invariant persists")]]);
    assert.ok(!diagnostics.some((warning) => warning.code === "W_NO_INVARIANTS" && warning.contract === "Store"), compiler);
    assert.deepEqual(index.edges.filter((edge) => edge.kind === "extends").map(({ to, toModule }) => [to, toModule]), [["Reader", "src/io"], ["Writer", "src/io"]]);

    writeFile(root, designFile("store"), mdx('import type * as io from "../io/io.cage.mdx";', declaration("contract", "Store", "Store extends io.Reader", ["clear(): void;"])));
    const spaced = checkDesigns(root);
    assert.deepEqual(spaced.errors, [], compiler);
    assert.deepEqual(spaced.index.contracts.find((contract) => contract.name === "Store")!.members.map(({ name }) => name), ["clear", "read", "size"]);
    // Only @data bases: nothing promised, the usual warning.
    assert.ok(spaced.diagnostics.some((warning) => warning.code === "W_NO_INVARIANTS" && warning.contract === "Store"), compiler);
  }
});

/** @tests Cli
 * @covers contract-inheritance */
test("a diamond hands on the common ancestor's members and promises once", (t) => {
  for (const compiler of COMPILERS) {
    const base = declaration("contract", "Base", "Base", ["/** @invariant stable ids never change */", "id(): string;"]);
    const left = declaration("contract", "Left", "Left extends Base", ["left(): void;"], "@invariant left-rule left");
    const right = declaration("contract", "Right", "Right extends Base", ["right(): void;"], "@invariant right-rule right");
    const both = declaration("contract", "Both", "Both extends Left, Right", []);
    const root = project(t, compiler, { m: mdx(base, left, right, both) });
    const { errors, index } = checkDesigns(root);
    assert.deepEqual(errors, [], compiler);
    assert.deepEqual(index.contracts.find((contract) => contract.name === "Both")!.members.map(({ name, inheritedFrom }) => [name, inheritedFrom?.name]), [
      ["left", "Left"],
      ["id", "Base"],
      ["right", "Right"],
    ]);
    assert.deepEqual(index.invariants.filter((invariant) => invariant.contract === "Both").map(({ id, inheritedFrom }) => [id, inheritedFrom?.contract]), [
      ["left-rule", "Left"],
      ["right-rule", "Right"],
      ["stable", "Base"],
    ]);
    const source = index.contracts.find((contract) => contract.name === "Both")!.source;
    assert.equal(source.split("export interface Base").length, 2, "the common ancestor's declaration is in the material once");
  }
});

/** @tests Cli
 * @covers contract-inheritance */
test("invalid and incompatible bases, cycles and conflicting inherited metadata are errors", (t) => {
  const cases: { name: string; designs: Record<string, string>; code: string; tsCode?: number; message?: RegExp; module?: string; needle?: string }[] = [
    {
      name: "a base outside the designs",
      designs: { m: mdx(declaration("contract", "Failure", "Failure extends Error", ["retry(): void;"])) },
      code: "E_UNSUPPORTED_DECLARATION",
      message: /`extends Error`: a contract extends `@contract` or `@data` declarations of the designs, or the types of an imported package/,
      needle: "Error {",
    },
    {
      name: "an own invariant that shadows an inherited one",
      designs: { m: mdx(WRITER, declaration("contract", "Store", "Store extends Writer", ["clear(): void;"], "@invariant persists something else")) },
      code: "E_INVARIANT_DUPLICATE",
      message: /Store\.persists declared by "Store" and inherited from "Writer"/,
      needle: "@invariant persists something else",
    },
    {
      name: "one invariant id from two bases",
      designs: {
        m: mdx(
          WRITER,
          declaration("contract", "Archive", "Archive", ["archive(): void;"], "@invariant persists archived values survive a restart"),
          declaration("contract", "Store", "Store extends Writer, Archive", []),
        ),
      },
      code: "E_INVARIANT_DUPLICATE",
      message: /Store\.persists inherited from "Writer" and inherited from "Archive"/,
    },
    {
      name: "an inherited index signature",
      designs: { m: mdx(declaration("data", "Bag", "Bag", ["[key: string]: unknown;"]), declaration("contract", "Store", "Store extends Bag", ["clear(): void;"])) },
      code: "E_UNSUPPORTED_DECLARATION",
      message: /inherits an index signature/,
    },
    {
      name: "a contract's API through a @data alias, without its promises",
      designs: { m: mdx(WRITER, "/**\n * @data\n * @description Part.\n */\nexport type Part = Pick<Writer, \"write\">;", declaration("contract", "Store", "Store extends Part", [])) },
      code: "E_UNSUPPORTED_DECLARATION",
      message: /inherits "write" of contract "Writer" without extending it/,
    },
    {
      name: "an inherited construct signature",
      designs: { m: mdx(declaration("data", "Make", "Make", ["new (): object;"]), declaration("contract", "Store", "Store extends Make", ["clear(): void;"])) },
      code: "E_UNSUPPORTED_DECLARATION",
      message: /inherits a construct signature/,
    },
    {
      name: "a redeclaration the base does not allow",
      designs: { m: mdx(READER, declaration("contract", "Store", "Store extends Reader", ["read(id: number): string;"])) },
      code: "E_TYPESCRIPT",
      tsCode: 2430,
    },
    {
      name: "incompatible bases",
      designs: { m: mdx(READER, declaration("data", "Sized", "Sized", ["readonly size: string;"]), declaration("contract", "Store", "Store extends Reader, Sized", [])) },
      code: "E_TYPESCRIPT",
      tsCode: 2320,
    },
    {
      name: "a cycle inside a module",
      designs: { m: mdx(declaration("contract", "A", "A extends B", ["a(): void;"]), declaration("contract", "B", "B extends A", ["b(): void;"])) },
      code: "E_TYPESCRIPT",
      tsCode: 2310,
    },
    {
      name: "a cycle between modules",
      designs: {
        a: mdx('import type { B } from "../b/b.cage.mdx";', declaration("contract", "A", "A extends B", ["a(): void;"])),
        b: mdx('import type { A } from "../a/a.cage.mdx";', declaration("contract", "B", "B", ["b(): void;", "a(): A;"])),
      },
      code: "E_DESIGN_CYCLE",
    },
  ];
  for (const compiler of COMPILERS) {
    for (const { name, designs, code, tsCode, message, needle, module = Object.keys(designs)[0] } of cases) {
      const root = project(t, compiler, designs);
      const { errors } = checkDesigns(root);
      const found = errors.find((error) => error.code === code && (tsCode === undefined || error.tsCode === tsCode));
      assert.ok(found, `${compiler}: ${name}: ${JSON.stringify(errors.map(({ code, tsCode, message }) => ({ code, tsCode, message })))}`);
      if (message) assert.match(found.message, message, `${compiler}: ${name}`);
      if (needle) assert.deepEqual({ file: found.file, line: found.line, column: found.column }, at(root, module, needle), `${compiler}: ${name}`);
      assert.equal(cli(root, "check", "--phase", "design").code, 1, `${compiler}: ${name}`);
    }
  }
});

/** @tests Cli
 * @covers contract-inheritance */
test("a lock on a derived contract holds its inherited signatures and invariants", (t) => {
  for (const compiler of COMPILERS) {
    const store = (lock: string) => declaration("contract", "Store", "Store extends Reader, Writer", [], "@invariant counts size counts the stored ids", lock);
    const root = project(t, compiler, { store: mdx(READER, WRITER, store("@final")) }, STORE_FILES);
    assert.equal(cli(root, "lock").code, 0, compiler);
    const record = JSON.parse(readFile(root, ".cage/lock.json"));
    const entry = JSON.stringify(record);
    for (const expected of ['"read":"read(id: string): string | undefined;"', '"size":"readonly size: number;"', '"write":"write(id: string, value: string): void;"', '"persists":"a written value is read back"', '"counts":"size counts the stored ids"']) {
      assert.ok(entry.includes(expected), `${compiler}: ${expected} in ${entry}`);
    }
    const document = designFile("store");
    const violation = () => check(root).report.diagnostics.filter((diagnostic) => diagnostic.code === "E_LOCK_VIOLATION" && diagnostic.contract === "Store");

    // A changed, a removed or an added inherited member, and a changed inherited invariant, change the final contract.
    for (const [from, to, words] of [
      ["read(id: string): string | undefined;", "read(id: string): string;", /read/],
      ["  readonly size: number;\n", "", /size/],
      ["  readonly size: number;\n", "  readonly size: number;\n  clear(): void;\n", /clear/],
      ["a written value is read back", "a written value is kept", /persists/],
    ] as const) {
      editFile(root, document, (text) => text.replace(from, to));
      const found = violation();
      assert.equal(found.length, 1, `${compiler}: ${from} -> ${to}`);
      assert.match(found[0].message, words);
      writeFile(root, document, mdx(READER, WRITER, store("@final")));
    }
    assert.deepEqual(violation(), [], compiler);

    // An extendable contract takes an inherited addition as an extension, not yet recorded.
    fs.rmSync(path.join(root, ".cage/lock.json"));
    writeFile(root, document, mdx(READER, WRITER, store("@extendable")));
    assert.equal(cli(root, "lock").code, 0, compiler);
    editFile(root, document, (text) => text.replace("  readonly size: number;\n", "  readonly size: number;\n  clear(): void;\n"));
    const report = check(root).report;
    assert.deepEqual(report.diagnostics.filter((diagnostic) => diagnostic.code === "E_LOCK_VIOLATION"), [], compiler);
    assert.ok(report.diagnostics.some((diagnostic) => diagnostic.code === "W_LOCK_UNRECORDED" && diagnostic.message === "Contract \"Store\": `clear` not locked yet"), compiler);
    editFile(root, document, (text) => text.replace("read(id: string): string | undefined;", "read(id: string): string;"));
    assert.ok(check(root).report.diagnostics.some((diagnostic) => diagnostic.code === "E_LOCK_VIOLATION" && diagnostic.contract === "Store"), compiler);
  }
});

/** @tests Cli
 * @covers contract-inheritance */
test("an edit to a local or imported base outdates the derived contract's review, not an unrelated one", (t) => {
  for (const compiler of COMPILERS) {
    const other = declaration("contract", "Clock", "Clock", ["now(): number;"], "@invariant monotonic time does not go back");
    const root = project(t, compiler, { store: mdx(READER, WRITER, STORE, other) }, {
      ...STORE_FILES,
      "src/store/clock.ts": "/** @implements Clock */\nexport const clock = { now: (): number => 0 };\n",
      "src/store/clock.test.ts": testsOf("Clock", "monotonic"),
    });
    assert.equal(cli(root, "review", "--accept").code, 0, compiler);
    const stale = () => check(root).report.diagnostics.filter((diagnostic) => diagnostic.code === "W_REVIEW_STALE").map(({ contract }) => contract).sort();
    assert.deepEqual(stale(), [], compiler);

    // A local @data base: only the contract that extends it.
    editFile(root, designFile("store"), (text) => text.replace("read(id: string): string | undefined;", "read(id: string): string | null;"));
    writeFile(root, "src/store/store.ts", STORE_IMPL.replace("string | undefined { return this.#values.get(id); }", "string | null { return this.#values.get(id) ?? null; }"));
    assert.deepEqual(stale(), ["Store"], compiler);
    const message = check(root).report.diagnostics.find((diagnostic) => diagnostic.code === "W_REVIEW_STALE")!.message;
    assert.match(message, /contract declaration/);

    // A base contract's invariant: the base and the contract that inherits it.
    assert.equal(cli(root, "review", "--accept").code, 0, compiler);
    editFile(root, designFile("store"), (text) => text.replace("a written value is read back", "a written value is read back unchanged"));
    assert.deepEqual(stale(), ["Store", "Writer"], compiler);
  }

  for (const compiler of COMPILERS) {
    const root = project(t, compiler, {
      io: mdx(READER),
      store: mdx('import type { Reader } from "../io/io.cage.mdx";', declaration("contract", "Store", "Store extends Reader", ["clear(): void;"], "@invariant empties clear leaves no ids")),
    }, {
      "src/store/store.ts": "/** @implements Store */\nexport class MemoryStore { get size(): number { return 0; } read(id: string): string | undefined { return id; } clear(): void {} }\n",
      "src/store/store.test.ts": testsOf("Store", "empties"),
    });
    assert.equal(cli(root, "review", "--accept").code, 0, compiler);
    editFile(root, designFile("io"), (text) => text.replace("readonly size: number;", "readonly size: number; // how many\n  /** The number of ids. */"));
    assert.deepEqual(check(root).report.diagnostics.filter((diagnostic) => diagnostic.code === "W_REVIEW_STALE").map(({ contract }) => contract), ["Store"], compiler);
  }
});

/** @tests Cli
 * @covers contract-inheritance */
test("a contract without bases keeps its material and lock record as they were", (t) => {
  const plain = declaration("contract", "Plain", "Plain", ["run(): void;"], "@invariant runs it runs", "@final");
  const root = project(t, "typescript", { m: mdx(plain) });
  const { index, errors } = checkDesigns(root);
  assert.deepEqual(errors, []);
  const contract = index.contracts[0];
  assert.equal(contract.bases, undefined);
  assert.ok(contract.source.endsWith(plain) && !contract.source.slice(0, -plain.length).includes("interface"));
  assert.deepEqual(index.locked[0].members, { run: "run(): void;" });
  assert.equal(index.edges.length, 0);
  assert.deepEqual(codes(checkDesigns(root).diagnostics), []);
});

/** @tests Cli
 * @covers contract-inheritance */
test("inherited overloads, generic methods and a call signature next to members are the contract's API, compared exactly", (t) => {
  const reads = declaration("data", "Reads", "Reads", ["read(): string;", "read(id: string): string;", "map<T>(fn: (value: string) => T): T[];", "readonly size?: number;"]);
  const store = declaration("contract", "Store", "Store extends Reads", [], "@invariant reads read returns the stored value", "@final");
  const impl = [
    "/** @implements Store */",
    "export class MemoryStore {",
    "  read(): string;",
    "  read(id: string): string;",
    "  read(id?: string): string { return id ?? \"\"; }",
    "  map<T>(fn: (value: string) => T): T[] { return [fn(\"\")]; }",
    "  readonly size?: number;",
    "}",
    "",
  ].join("\n");
  for (const compiler of COMPILERS) {
    const root = project(t, compiler, { store: mdx(reads, store) }, { "src/store/store.ts": impl, "src/store/store.test.ts": testsOf("Store", "reads") });
    const result = checkLinking(root);
    assert.deepEqual(result.errors, [], compiler);
    assert.deepEqual(result.index!.contracts[0].members.map(({ name, location }) => [name, location]), [
      ["read", at(root, "store", "read(): string;")],
      ["map", at(root, "store", "map<T>")],
      ["size", at(root, "store", "readonly size?")],
    ]);
    assert.equal(cli(root, "lock").code, 0, compiler);
    const record = JSON.stringify(JSON.parse(readFile(root, ".cage/lock.json")));
    // Overloads are recorded together, with their modifiers.
    assert.ok(record.includes('"read":"read(): string; read(id: string): string;"'), `${compiler}: ${record}`);
    assert.ok(record.includes('"size":"readonly size?: number;"'), compiler);
    assert.equal(cli(root, "check").code, 0, compiler);

    // The comparison is the exact one: a missing overload or a drifting generic is found in the implementation.
    writeFile(root, "src/store/store.ts", impl.replace("  read(): string;\n", ""));
    assert.ok(checkLinking(root).errors.some((error) => error.contract === "Store" && ["E_TYPE_MISMATCH", "E_CONTRACT_SIGNATURE"].includes(error.code)), compiler);
    writeFile(root, "src/store/store.ts", impl);
    // An overload taken away from the base is a lock violation of the derived contract.
    editFile(root, designFile("store"), (text) => text.replace("  read(): string;\n", ""));
    writeFile(root, "src/store/store.ts", impl.replace("  read(): string;\n", ""));
    assert.ok(check(root).report.diagnostics.some((diagnostic) => diagnostic.code === "E_LOCK_VIOLATION" && diagnostic.contract === "Store" && diagnostic.message.includes("read")), compiler);
  }

  for (const compiler of COMPILERS) {
    const run = declaration("data", "Run", "Run", ["(input: string): number;", "(input: number): number;", "readonly label: string;"]);
    const root = project(t, compiler, { m: mdx(run, declaration("contract", "Task", "Task extends Run", ["describe(): string;"], "@invariant labelled label names the task")) }, {
      "src/m/task.ts": [
        "interface Shape { (input: string): number; (input: number): number; readonly label: string; describe(): string }",
        "const call = (input: string | number): number => String(input).length;",
        "/** @implements Task */",
        'export const task: Shape = Object.assign(call, { label: "task", describe: (): string => "task" });',
        "",
      ].join("\n"),
      "src/m/task.test.ts": testsOf("Task", "labelled"),
    });
    const { errors, index } = checkLinking(root);
    assert.deepEqual(errors, [], compiler);
    const task = index!.contracts[0];
    assert.equal(task.shape, "callable");
    assert.deepEqual(task.members.map(({ name, inheritedFrom }) => [name, inheritedFrom?.name]), [["describe", undefined], ["label", "Run"]]);
  }
});

/** @tests Cli
 * @covers contract-inheritance */
test("identical overlapping bases and a redeclaration the compiler allows keep the effective API and every inherited promise", (t) => {
  for (const compiler of COMPILERS) {
    const other = declaration("data", "Sized", "Sized", ["readonly size: number;"]);
    const audited = declaration("contract", "Audited", "Audited", ["/** @invariant logged a write is logged */", "write(id: string, value: string): void;"]);
    const store = declaration("contract", "Store", "Store extends Reader, Sized, Writer, Audited", ["read(id: string): string;", "write(id: string, value: string): void;"]);
    const root = project(t, compiler, { m: mdx(READER, other, WRITER, audited, store) });
    const { errors, index } = checkDesigns(root);
    assert.deepEqual(errors, [], compiler);
    const contract = index.contracts.find((candidate) => candidate.name === "Store")!;
    assert.deepEqual(contract.members.map(({ name, inheritedFrom, location }) => [name, inheritedFrom?.name, location]), [
      ["read", undefined, at(root, "m", "read(id: string): string;")],
      ["write", undefined, after(root, "m", "Store extends", "write(id")],
      ["size", "Reader", at(root, "m", "readonly size: number;")],
    ]);
    // Both promises about the redeclared `write` stay, each with where it was made.
    assert.deepEqual(index.invariants.filter((invariant) => invariant.contract === "Store").map(({ id, member, location }) => [id, member, location]), [
      ["persists", "write", at(root, "m", "@invariant persists")],
      ["logged", "write", at(root, "m", "@invariant logged")],
    ]);
  }
});

/**
 * A package's declarations as a base, before designs may import packages: the index and the resolver are given a
 * program in which a design file imports `pkg` (the design phase itself still rejects that import).
 */
function packageBases(t: TestContext, compiler: string, design: string) {
  const root = scratchDirectory(t, "package-bases");
  writeFile(root, "node_modules/pkg/package.json", JSON.stringify({ name: "pkg", version: "1.0.0", types: "./index.d.ts" }));
  writeFile(root, "node_modules/pkg/index.d.ts", [
    "export declare class Schema<T> {",
    "  private secret;",
    "  protected internal(): void;",
    "  readonly kind: string;",
    "  parse(value: unknown): T;",
    "  parse(value: unknown, strict: boolean): T;",
    "  map<U>(fn: (value: T) => U): Schema<U>;",
    "}",
    "export interface Callable {",
    "  (input: string): number;",
    "  label: string;",
    "}",
    "",
  ].join("\n"));
  writeFile(root, "design.ts", design);
  const typescript = createRequire(import.meta.url)(compiler) as typeof ts;
  const fileName = path.join(root, "design.ts");
  const program = typescript.createProgram([fileName], { strict: true, noEmit: true, module: typescript.ModuleKind.NodeNext, moduleResolution: typescript.ModuleResolutionKind.NodeNext, types: [] });
  const sourceFile = program.getSourceFile(fileName)!;
  const designs: DesignSourceFile[] = [{
    moduleId: "m",
    sourceFile,
    locate: (offset) => {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(offset);
      return { file: "design.ts", line: line + 1, column: character + 1 };
    },
    blockOf: () => 0,
    writtenSpecifier: (specifier) => specifier.text,
  }];
  const semantic = program.getSemanticDiagnostics(sourceFile).map((diagnostic) => typescript.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
  // What the design phase would say about the import is not the subject here.
  const { index } = indexDesigns(typescript, designs, () => ({ moduleId: "pkg", documents: [] }));
  const diagnostics = resolveInheritance(typescript, program.getTypeChecker(), designs, index, (file) => file === path.join(root, "node_modules/pkg/index.d.ts") ? { kind: "package", module: "pkg" } : undefined);
  return { index, diagnostics, semantic, version: typescript.version, position: (needle: string) => ({ file: "design.ts", ...find(design, needle) }) };
}

/** @tests Cli
 * @covers contract-inheritance */
test("a base may be a package's class or interface, named through an import: its public API, overloads and instantiation", (t) => {
  const design = [
    'import type { Schema } from "pkg";',
    'import type * as p from "pkg";',
    "/**",
    " * @contract",
    " * @description Parser.",
    " * @invariant strict parse rejects unknown keys",
    " * @final",
    " */",
    "export interface Parser extends Schema<string> {}",
    "/**",
    " * @contract",
    " * @description Counter.",
    " * @invariant counts counts the input",
    " */",
    "export interface Counter extends p.Callable {}",
    "",
  ].join("\n");
  for (const compiler of COMPILERS) {
    const { index, diagnostics, semantic, version, position } = packageBases(t, compiler, design);
    assert.equal(version, compiler === "typescript-5" ? "5.9.3" : "6.0.3");
    assert.deepEqual(semantic, [], compiler);
    assert.deepEqual(diagnostics, [], compiler);
    const parser = index.contracts.find((contract) => contract.name === "Parser")!;
    assert.deepEqual(parser.bases, [{ name: "Schema", module: "pkg", kind: "package" }]);
    // Public members only, each where the design brings it in; private and protected ones are no public API.
    assert.deepEqual(parser.members.map(({ name, location, inheritedFrom }) => [name, location, inheritedFrom]), ["kind", "parse", "map"].map((name) => [name, position("Schema<string>"), { name: "Schema", module: "pkg", kind: "package" }]));
    assert.equal(parser.shape, "object");
    const counter = index.contracts.find((contract) => contract.name === "Counter")!;
    assert.equal(counter.shape, "callable");
    assert.deepEqual(counter.members.map(({ name, location }) => [name, location]), [["label", position("p.Callable")]]);
    // A package base is no design module: no edge to one.
    assert.deepEqual(index.edges.filter((edge) => edge.kind === "extends"), []);
    // The lock holds the overloads together and what the generic declaration was instantiated with.
    const locked = index.locked.find((declaration) => declaration.name === "Parser")!;
    assert.equal(locked.members.parse, "parse(value: unknown): T; parse(value: unknown, strict: boolean): T; as { (value: unknown): string; (value: unknown, strict: boolean): string; }");
    assert.equal(locked.members.kind, "readonly kind: string; as string");
    assert.equal(locked.members.secret, undefined);
    assert.equal(locked.members[":extends"], "extends Schema<string>");
    assert.deepEqual(locked.invariants, { strict: "parse rejects unknown keys" });

    const instantiated = packageBases(t, compiler, design.replace("Schema<string>", "Schema<number>"));
    assert.notEqual(instantiated.index.locked.find((declaration) => declaration.name === "Parser")!.members.parse, locked.members.parse, compiler);
  }

  for (const compiler of COMPILERS) {
    // A global of a declaration file is not a package base: only what the design imports is.
    const { diagnostics } = packageBases(t, compiler, ["/**", " * @contract", " * @description Failure.", " */", "export interface Failure extends Error {", "  retry(): void;", "}", ""].join("\n"));
    assert.deepEqual(diagnostics.map(({ code, message }) => [code, message]), [["E_UNSUPPORTED_DECLARATION", "Failure: `extends Error`: a contract extends `@contract` or `@data` declarations of the designs, or the types of an imported package"]], compiler);
  }
});

/** @tests Cli
 * @covers contract-inheritance */
test("a lock on a contract extending an instantiated generic @data base notices a change of the argument", (t) => {
  for (const compiler of COMPILERS) {
    const box = ["/**", " * @data", " * @description Box.", " * @final", " */", "export interface Box<T> {", "  readonly value: T;", "}"].join("\n");
    const store = (argument: string) => declaration("contract", "Store", `Store extends Box<${argument}>`, ["clear(): void;"], "@invariant empties clear empties it", "@final");
    const root = project(t, compiler, { m: mdx(box, store("string")) });
    assert.equal(cli(root, "lock").code, 0, compiler);
    assert.equal(cli(root, "check", "--phase", "design").code, 0, compiler);
    writeFile(root, designFile("m"), mdx(box, store("number")));
    const report = JSON.parse(cli(root, "check", "--phase", "design", "--format", "json").stdout) as CheckReport;
    const violation = report.diagnostics.find((diagnostic) => diagnostic.code === "E_LOCK_VIOLATION" && diagnostic.contract === "Store");
    assert.ok(violation && violation.message.includes("value"), `${compiler}: ${JSON.stringify(report.diagnostics)}`);
  }
});
