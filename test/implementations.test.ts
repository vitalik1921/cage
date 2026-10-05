import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { checkLinking, contract, copyFixture, designFile, designProject, editFile, inFile, located, mdx } from "./helpers.ts";

const STORE = contract("Store", "get(key: string): Promise<string | null>;\n  put(key: string, value: string): Promise<void>;", "@invariant miss Для невідомого ключа повертає null.");
const CLEAN = ["/**", " * @contract", " * @description Нормалізує пробіли.", " * @invariant spaces Стискає пробіли.", " */", "export interface CleanTitle {", "  (input: string): string;", "}"].join("\n");

/** Test declarations that link every invariant of the two contracts, so that only implementations are in question. */
const TESTS = [
  'import { describe, it } from "node:test";',
  "/** @tests Store */",
  'describe("Store", () => {',
  "  /** @covers miss */",
  '  it("misses", () => { return; });',
  "});",
  "/** @tests CleanTitle */",
  'describe("CleanTitle", () => {',
  "  /** @covers spaces */",
  '  it("cleans", () => { return; });',
  "});",
  "",
].join("\n");

const STORE_CLASS = [
  "/** @implements Store */",
  "export class MemoryStore {",
  "  private readonly values = new Map<string, string>();",
  "  async get(key: string): Promise<string | null> {",
  "    return this.values.get(key) ?? null;",
  "  }",
  "  async put(key: string, value: string): Promise<void> {",
  "    this.values.set(key, value);",
  "  }",
  "}",
  "",
].join("\n");
const CLEAN_FUNCTION = ["/** @implements CleanTitle */", "export function cleanTitle(input: string): string {", '  return input.trim().replace(/\\s+/g, " ");', "}", ""].join("\n");

/** A project with the Store and CleanTitle contracts, their tests, and the given source files. */
function project(t: TestContext, files: Record<string, string>): string {
  return designProject(t, { m: mdx(STORE, CLEAN) }, { "src/m/contracts.test.ts": TESTS, ...files });
}

const codes = (root: string) => checkLinking(root).errors.map(located);

test("the plan fixture links three implementations to their contracts", (t) => {
  const root = copyFixture(t, "vertical");
  const { linking, errors } = checkLinking(root);
  assert.deepEqual(errors, []);
  assert.deepEqual(linking.implementations, [
    { contract: "Send", name: "SendService", kind: "class", compatible: true, location: inFile(root, "src/modules/campaigns/send-service.ts", "SendService") },
    { contract: "Sender", name: "CallbackSender", kind: "class", compatible: true, location: inFile(root, "src/modules/mail/callback-sender.ts", "CallbackSender") },
    { contract: "Quota", name: "MemoryQuota", kind: "class", compatible: true, location: inFile(root, "src/modules/quota/memory-quota.ts", "MemoryQuota") },
  ]);
});

test("classes, functions and consts implement contracts by their shape", (t) => {
  const root = project(t, {
    // Extra public members, private state and constructor parameters are not part of the contract.
    "src/m/memory-store.ts": STORE_CLASS.replace("export class MemoryStore {", "export class MemoryStore {\n  constructor(readonly name: string) {}\n  size(): number {\n    return 0;\n  }"),
    "src/m/clean-title.ts": CLEAN_FUNCTION,
    "src/other/arrow.ts": '/** @implements CleanTitle */\nexport const tidy = (input: string): string => input.trim();\n',
    "src/other/object.ts": [
      "/**",
      " * An object literal is an implementation too.",
      " * @implements Store",
      " * @description In-memory, for tests.",
      " */",
      "export const nullStore = {",
      "  get: async (_key: string): Promise<string | null> => null,",
      "  put: async (_key: string, _value: string): Promise<void> => {},",
      "};",
      "",
    ].join("\n"),
  });
  const { linking, errors } = checkLinking(root);
  assert.deepEqual(errors, []);
  assert.deepEqual(
    linking.implementations.map(({ contract, name, kind, compatible }) => [contract, name, kind, compatible]),
    [
      ["CleanTitle", "cleanTitle", "function", true],
      ["Store", "MemoryStore", "class", true],
      ["CleanTitle", "tidy", "const", true],
      ["Store", "nullStore", "const", true],
    ],
  );
});

test("an implementation that does not fit its contract is a type mismatch, explained by the compiler", (t) => {
  const root = project(t, {
    "src/m/clean-title.ts": CLEAN_FUNCTION,
    "src/m/memory-store.ts": STORE_CLASS,
    // A missing method.
    "src/m/half-store.ts": "/** @implements Store */\nexport class HalfStore {\n  async get(_key: string): Promise<string | null> {\n    return null;\n  }\n}\n",
    // An incompatible result.
    "src/m/sync-store.ts": "/** @implements Store */\nexport class SyncStore {\n  get(_key: string): string | null {\n    return null;\n  }\n  async put(): Promise<void> {}\n}\n",
    // The methods exist only on the class itself: an instance has none.
    "src/m/static-store.ts": "/** @implements Store */\nexport class StaticStore {\n  static async get(_key: string): Promise<string | null> {\n    return null;\n  }\n  static async put(): Promise<void> {}\n}\n",
    // A class is not callable.
    "src/m/cleaner.ts": "/** @implements CleanTitle */\nexport class Cleaner {\n  clean(input: string): string {\n    return input;\n  }\n}\n",
    // A function with the wrong result.
    "src/m/length.ts": "/** @implements CleanTitle */\nexport const length = (input: string): number => input.length;\n",
    // A const that holds a class, not an instance.
    "src/m/store-class.ts": "/** @implements Store */\nexport const StoreClass = class {\n  async get(): Promise<string | null> {\n    return null;\n  }\n  async put(): Promise<void> {}\n};\n",
  });
  const { linking, diagnostics } = checkLinking(root);

  const mismatches = diagnostics.filter((diagnostic) => diagnostic.code === "E_TYPE_MISMATCH");
  assert.deepEqual(mismatches.map(located), [
    { code: "E_TYPE_MISMATCH", ...inFile(root, "src/m/cleaner.ts", "Cleaner") },
    { code: "E_TYPE_MISMATCH", ...inFile(root, "src/m/half-store.ts", "HalfStore") },
    { code: "E_TYPE_MISMATCH", ...inFile(root, "src/m/length.ts", "length") },
    { code: "E_TYPE_MISMATCH", ...inFile(root, "src/m/static-store.ts", "StaticStore") },
    { code: "E_TYPE_MISMATCH", ...inFile(root, "src/m/store-class.ts", "StoreClass") },
    { code: "E_TYPE_MISMATCH", ...inFile(root, "src/m/sync-store.ts", "SyncStore") },
  ]);
  assert.equal(diagnostics.filter((diagnostic) => diagnostic.severity === "error").length, mismatches.length);

  const half = mismatches[1];
  assert.equal(half.contract, "Store");
  assert.match(half.message, /^"HalfStore" does not fit contract "Store"\.\nType 'HalfStore' does not satisfy the expected type 'Store'\.\n\s+Property 'put' is missing in type 'HalfStore' but required in type 'Store'\.$/);
  // The contract is shown where it is authored, in the design document.
  assert.deepEqual(half.related?.[0], { message: "The contract.", ...inFile(root, designFile("m"), "interface Store", "interface ".length) });
  // What the compiler adds points at the contract's member in the design document, never at the in-memory check.
  assert.deepEqual(
    half.related?.slice(1).map(({ message, file, line, column }) => ({ message, file, line, column })),
    [{ message: "'put' is declared here.", ...inFile(root, designFile("m"), "put(key: string") }],
  );
  for (const mismatch of mismatches) assert.ok(mismatch.related?.every((related) => !related.file?.includes("cage-check")), mismatch.message);
  assert.match(mismatches[5].message, /Type 'string \| null' is not assignable to type 'Promise<string \| null>'/);

  assert.deepEqual(
    linking.implementations.filter((implementation) => !implementation.compatible).map((implementation) => implementation.name).sort(),
    ["Cleaner", "HalfStore", "StaticStore", "StoreClass", "SyncStore", "length"],
  );
});

test("what TypeScript accepts, the harness accepts: any, assertions and method parameters", (t) => {
  const root = project(t, {
    "src/m/clean-title.ts": CLEAN_FUNCTION,
    // `any` fits everything.
    "src/m/any-store.ts": "/** @implements Store */\nexport const anyStore: any = {};\n",
    // An assertion silences the mismatch where it is made, inside the implementation.
    "src/m/asserted-store.ts": "/** @implements Store */\nexport const assertedStore = {\n  get: (async () => 1) as unknown as (key: string) => Promise<string | null>,\n  put: async (): Promise<void> => {},\n};\n",
    // Method parameters are compared bivariantly: a narrower parameter passes.
    "src/m/narrow-store.ts": '/** @implements Store */\nexport class NarrowStore {\n  async get(_key: "only-this-key"): Promise<string | null> {\n    return null;\n  }\n  async put(): Promise<void> {}\n}\n',
  });
  assert.deepEqual(codes(root), []);
});

test("only a tag links an implementation: a contract without one has no implementation", (t) => {
  const root = project(t, {
    "src/m/clean-title.ts": CLEAN_FUNCTION,
    // Native `implements`, and the right shape, but no `@implements` tag.
    "src/m/memory-store.ts": `interface Store {\n  get(key: string): Promise<string | null>;\n}\n\n${STORE_CLASS.replace("/** @implements Store */\n", "").replace("export class MemoryStore {", "export class MemoryStore implements Store {")}`,
  });
  assert.deepEqual(codes(root), [{ code: "E_IMPLEMENTATION_MISSING", file: designFile("m"), ...position(root, "interface Store", "interface ".length) }]);
});

test("the tag decides the contract, whatever a native implements clause says", (t) => {
  const root = project(t, {
    "src/m/clean-title.ts": CLEAN_FUNCTION,
    "src/m/memory-store.ts": `interface CleanTitle {\n  (input: string): string;\n}\n\n${STORE_CLASS}`.replace("export class MemoryStore {", "export class MemoryStore implements Partial<CleanTitle> {"),
  });
  const { linking, errors } = checkLinking(root);
  assert.deepEqual(errors, []);
  assert.deepEqual(linking.implementations.map(({ contract, name }) => [contract, name]), [["CleanTitle", "cleanTitle"], ["Store", "MemoryStore"]]);
});

const position = (root: string, needle: string, offset = 0) => {
  const { line, column } = inFile(root, designFile("m"), needle, offset);
  return { line, column };
};

test("@implements names known contracts, one or several, in one tag or one per line", (t) => {
  const root = project(t, {
    "src/m/clean-title.ts": CLEAN_FUNCTION,
    "src/m/memory-store.ts": STORE_CLASS,
    "src/m/unknown.ts": "/** @implements Stor */\nexport class Typo {}\n",
    "src/m/empty.ts": "/** @implements */\nexport class Empty {}\n",
    "src/m/typed.ts": "/** @implements {Store} */\nexport class Typed {}\n",
  });
  const found = checkLinking(root);
  assert.deepEqual(found.errors.map(located), [
    { code: "E_TAG_FORMAT", ...inFile(root, "src/m/empty.ts", "@implements") },
    { code: "E_TAG_FORMAT", ...inFile(root, "src/m/typed.ts", "@implements") },
    { code: "E_REFERENCE_UNKNOWN", ...inFile(root, "src/m/unknown.ts", "@implements") },
  ]);
  assert.equal(found.errors.at(-1)?.message, "`@implements Stor`: there is no contract with this name.");
  assert.deepEqual(found.linking.implementations.map((implementation) => implementation.name), ["cleanTitle", "MemoryStore"]);

  // One declaration may implement several contracts; each is checked on its own.
  const both = [
    "/**",
    " * @implements Store CleanTitle",
    " */",
    "export class Both {",
    "  async get(key: string): Promise<string | null> {",
    "    return key;",
    "  }",
    "  async put(_key: string, _value: string): Promise<void> {}",
    "}",
    "/**",
    " * @implements Store",
    " * @implements CleanTitle",
    " */",
    "export const twice = {",
    "  async get(key: string): Promise<string | null> {",
    "    return key;",
    "  },",
    "  async put(_key: string, _value: string): Promise<void> {},",
    "};",
    "",
  ].join("\n");
  const several = project(t, { "src/m/both.ts": both });
  const linked = checkLinking(several);
  assert.deepEqual(
    linked.linking.implementations.map(({ contract, name, compatible }) => [contract, name, compatible]),
    [["Store", "Both", true], ["CleanTitle", "Both", false], ["Store", "twice", true], ["CleanTitle", "twice", false]],
  );
  assert.deepEqual(linked.errors.map(({ code, contract }) => ({ code, contract })), [{ code: "E_TYPE_MISMATCH", contract: "CleanTitle" }, { code: "E_TYPE_MISMATCH", contract: "CleanTitle" }]);
});

test("@implements needs an exported, named class, function or const", (t) => {
  const cases: Record<string, string> = {
    "default-class": "/** @implements Store */\nexport default class DefaultStore {}\n",
    "default-value": "const store = {};\n/** @implements Store */\nexport default store;\n",
    local: "/** @implements Store */\nclass LocalStore {}\nexport { LocalStore };\n",
    abstract: "/** @implements Store */\nexport abstract class AbstractStore {}\n",
    generic: "/** @implements Store */\nexport class GenericStore<T, U = string> {\n  value?: T;\n  other?: U;\n}\n",
    overloaded: "export function clean(input: string): string;\n/** @implements CleanTitle */\nexport function clean(input: string, extra?: number): string {\n  return input + String(extra);\n}\n",
    destructured: "/** @implements Store */\nexport const { store } = { store: {} };\n",
    several: "/** @implements Store */\nexport const one = {}, two = {};\n",
    mutable: "/** @implements Store */\nexport let mutable = {};\n",
    ambient: "/** @implements CleanTitle */\nexport declare function ambient(input: string): string;\n",
  };
  const root = project(t, {
    "src/m/clean-title.ts": CLEAN_FUNCTION,
    "src/m/memory-store.ts": STORE_CLASS,
    ...Object.fromEntries(Object.entries(cases).map(([name, text]) => [`src/m/${name}.ts`, text])),
  });
  assert.deepEqual(
    codes(root),
    Object.keys(cases)
      .sort()
      .map((name) => ({ code: "E_UNSUPPORTED_DECLARATION", ...inFile(root, `src/m/${name}.ts`, "@implements") })),
  );
});

test("a generic class with defaults for every type parameter is checked at those defaults", (t) => {
  const root = project(t, {
    "src/m/clean-title.ts": CLEAN_FUNCTION,
    "src/m/generic-store.ts": [
      "/** @implements Store */",
      "export class GenericStore<V extends string = string> {",
      "  private readonly values = new Map<string, V>();",
      "  async get(key: string): Promise<V | null> {",
      "    return this.values.get(key) ?? null;",
      "  }",
      "  async put(key: string, value: V): Promise<void> {",
      "    this.values.set(key, value);",
      "  }",
      "}",
      "",
    ].join("\n"),
  });
  const { linking, errors } = checkLinking(root);
  assert.deepEqual(errors, []);
  assert.deepEqual(linking.implementations.map(({ contract, name, compatible }) => [contract, name, compatible]), [["CleanTitle", "cleanTitle", true], ["Store", "GenericStore", true]]);
  // At another default the class no longer fits.
  editFile(root, "src/m/generic-store.ts", (s) => s.replace("V extends string = string", "V extends number = number"));
  assert.deepEqual(checkLinking(root).errors.map(({ code, contract }) => ({ code, contract })), [{ code: "E_TYPE_MISMATCH", contract: "Store" }]);
});

test("a decorated class takes the tag above its decorators", (t) => {
  const decorator = "const Injectable = () => (_target: unknown, _context?: unknown) => {};\n\n";
  const root = project(t, {
    "src/m/clean-title.ts": CLEAN_FUNCTION,
    "src/m/memory-store.ts": decorator + STORE_CLASS.replace("export class MemoryStore {", "@Injectable()\nexport class MemoryStore {"),
  });
  const { linking, errors } = checkLinking(root);
  assert.deepEqual(errors, []);
  assert.deepEqual(linking.implementations.map((implementation) => implementation.name), ["cleanTitle", "MemoryStore"]);

  // Between the decorator and the class the comment is inside the declaration, not before it.
  const between = project(t, {
    "src/m/clean-title.ts": CLEAN_FUNCTION,
    "src/m/memory-store.ts": decorator + STORE_CLASS.replace("/** @implements Store */\nexport class MemoryStore {", "@Injectable()\n/** @implements Store */\nexport class MemoryStore {"),
  });
  const misplaced = checkLinking(between).errors;
  assert.deepEqual(misplaced.map(located), [{ code: "E_TAG_LOCATION", ...inFile(between, "src/m/memory-store.ts", "@implements Store") }]);
  assert.match(misplaced[0].message, /above its decorators/);
});

test("a rejected @implements is one error: its contract is not also reported as having no implementation", (t) => {
  const root = designProject(
    t,
    { m: mdx(STORE, CLEAN) },
    {
      "src/m/contracts.test.ts": TESTS,
      "src/m/abstract-store.ts": "/** @implements Store */\nexport abstract class AbstractStore {}\n",
      "src/m/ambient.ts": "/** @implements CleanTitle */\nexport declare function clean(input: string): string;\n",
    },
  );
  const { errors } = checkLinking(root);
  assert.deepEqual(errors.map(located), [
    { code: "E_UNSUPPORTED_DECLARATION", ...inFile(root, "src/m/abstract-store.ts", "@implements") },
    { code: "E_UNSUPPORTED_DECLARATION", ...inFile(root, "src/m/ambient.ts", "@implements") },
  ]);
  assert.equal(errors[1].message, "a `declare` declaration has no code: it is not an implementation.");

  // The same when the tag itself is what was rejected: glued punctuation, or a comment between it and the class.
  const written = designProject(
    t,
    { m: mdx(STORE, CLEAN) },
    {
      "src/m/contracts.test.ts": TESTS,
      "src/m/glued.ts": STORE_CLASS.replace("@implements Store", "@implements: Store"),
      "src/m/separated.ts": CLEAN_FUNCTION.replace("/** @implements CleanTitle */", "/** @implements CleanTitle */\n// why"),
    },
  );
  assert.deepEqual(checkLinking(written).errors.map(located), [
    { code: "E_TAG_FORMAT", ...inFile(written, "src/m/glued.ts", "@implements: Store") },
    { code: "E_TAG_LOCATION", ...inFile(written, "src/m/separated.ts", "@implements CleanTitle") },
  ]);
});

test("declarations without code are not implementations", (t) => {
  const root = project(t, {
    "src/m/clean-title.ts": CLEAN_FUNCTION,
    "src/m/ambient-class.ts": "/** @implements Store */\nexport declare class AmbientStore {\n  get(key: string): Promise<string | null>;\n  put(key: string, value: string): Promise<void>;\n}\n",
    "src/m/ambient-const.ts": "/** @implements Store */\nexport declare const ambientStore: { get(key: string): Promise<string | null>; put(key: string, value: string): Promise<void> };\n",
  });
  const { linking, errors } = checkLinking(root);
  assert.deepEqual(errors.map(located), [
    { code: "E_UNSUPPORTED_DECLARATION", ...inFile(root, "src/m/ambient-class.ts", "@implements") },
    { code: "E_UNSUPPORTED_DECLARATION", ...inFile(root, "src/m/ambient-const.ts", "@implements") },
  ]);
  assert.deepEqual(linking.implementations.map((implementation) => implementation.name), ["cleanTitle"]);
});

test("a contract without any implementation is reported even when an unrelated file cannot be read", (t) => {
  const root = project(t, {
    "src/m/clean-title.ts": CLEAN_FUNCTION,
    // Mentions a tag in a string, has a syntax error, and says nothing about Store.
    "src/m/notes.ts": 'export const support = "help@tests.example";\nexport const broken = {;\n',
  });
  assert.deepEqual(
    checkLinking(root).errors.map(({ code, file }) => ({ code, file })),
    [
      { code: "E_IMPLEMENTATION_MISSING", file: designFile("m") },
      { code: "E_TYPESCRIPT", file: "src/m/notes.ts" },
    ],
  );
});

test("compiler messages carry no path of this machine", (t) => {
  const root = designProject(
    t,
    {
      a: mdx(["/**", " * @data", " * @description Account of a.", " */", "export interface Account {", "  id: string;", "}"].join("\n"), contract("Writer", "save(account: Account): void;")),
      b: mdx(["/**", " * @data", " * @description Account of b.", " */", "export interface Account {", "  id: number;", "}"].join("\n")),
    },
    {
      "src/a/account.ts": "export interface Account {\n  id: number;\n}\n",
      "src/a/writer.ts": 'import type { Account } from "./account.ts";\n\n/** @implements Writer */\nexport class WrongWriter {\n  save(_account: Account): void {}\n}\n',
    },
  );
  const [mismatch] = checkLinking(root).errors;
  assert.equal(mismatch.code, "E_TYPE_MISMATCH");
  // The two types have one name, so the compiler tells them apart by their modules.
  assert.match(mismatch.message, /import\("src\/a\/account"/);
  assert.ok(!JSON.stringify(mismatch).includes(root), mismatch.message);
});

test("only a path that starts with the project root is shortened in compiler messages", async (t) => {
  const { createConverter } = await import("../src/design-phase.ts");
  const { loadTypeScript } = await import("../src/typescript.ts");
  const { ts } = loadTypeScript(process.cwd());
  const convert = createConverter(ts, "/app", undefined, new Map());
  const message = 'Type import("/app/src/app/orders").Order is not import("/app/packages/app/x").Order; see /home/ci/app/cache and "/app/a.ts"';
  const converted = convert("E_TYPESCRIPT", { category: ts.DiagnosticCategory.Error, code: 1, file: undefined, start: undefined, length: undefined, messageText: message });
  assert.equal(converted.message, 'Type import("src/app/orders").Order is not import("packages/app/x").Order; see /home/ci/app/cache and "a.ts"');
});

test("suppression comments in an implementation file hide its own errors, not a mismatch with the contract", (t) => {
  const root = project(t, {
    "src/m/clean-title.ts": CLEAN_FUNCTION,
    // The compiler reports nothing inside a @ts-nocheck file; the comparison with the contract is made outside it.
    "src/m/half-store.ts": '// @ts-nocheck\n/** @implements Store */\nexport class HalfStore {\n  async get(): Promise<string | null> {\n    return null;\n  }\n}\nexport const broken: number = "text";\n',
  });
  assert.deepEqual(checkLinking(root).errors.map(located), [{ code: "E_TYPE_MISMATCH", ...inFile(root, "src/m/half-store.ts", "HalfStore") }]);
});

test("an implementation file with syntax errors is reported and not read", (t) => {
  const root = project(t, {
    "src/m/clean-title.ts": CLEAN_FUNCTION,
    "src/m/memory-store.ts": STORE_CLASS.replace(/\}\n$/, ""),
  });
  const { linking, errors } = checkLinking(root);
  // What the file implements cannot be known, so nothing is said about a missing implementation.
  assert.deepEqual(errors.map(({ code, tsCode, file }) => ({ code, tsCode, file })), [{ code: "E_TYPESCRIPT", tsCode: 1005, file: "src/m/memory-store.ts" }]);
  assert.deepEqual(linking.implementations.map((implementation) => implementation.name), ["cleanTitle"]);
});

test("a harness tag in the wrong place of a source file is reported; ordinary doc comments are not read", (t) => {
  const root = project(t, {
    "src/m/clean-title.ts": CLEAN_FUNCTION,
    "src/m/memory-store.ts": STORE_CLASS,
    "src/m/misplaced.ts": [
      "export class Service {",
      "  /** @implements Store */",
      "  method(): void {}",
      "}",
      "",
      "/** @implements CleanTitle */",
      "// a comment in between breaks the binding",
      "export function separated(input: string): string {",
      "  return input;",
      "}",
      "",
      "/**",
      " * @contract",
      " * @invariant local Контракт оголошують у design.mdx.",
      " */",
      "export interface Local {}",
      "",
      "/** @covers miss */",
      "export const helper = 1;",
      "",
    ].join("\n"),
    "src/m/managed.ts": STORE_CLASS.replace("/** @implements Store */", "/**\n * @implements Store\n * @todo tidy up\n * @name Renamed\n * @description Дозволений звичайний опис.\n * @see Other\n */").replace("MemoryStore", "DocumentedStore"),
    // No binding tag anywhere: not the harness's to lint, whatever the doc comments say.
    "src/m/plain.ts": '/** @todo later\n * @description Звичайний JSDoc.\n * @author someone */\nexport const plain = "has @implements Store in a string";\n// @implements Store in a line comment\n',
  });
  assert.deepEqual(codes(root), [
    { code: "E_UNKNOWN_TAG", ...inFile(root, "src/m/managed.ts", "@todo") },
    { code: "E_UNSUPPORTED_TAG", ...inFile(root, "src/m/managed.ts", "@name") },
    { code: "E_TAG_LOCATION", ...inFile(root, "src/m/misplaced.ts", "@implements Store") },
    { code: "E_TAG_LOCATION", ...inFile(root, "src/m/misplaced.ts", "@implements CleanTitle") },
    { code: "E_TAG_LOCATION", ...inFile(root, "src/m/misplaced.ts", "@contract") },
    { code: "E_TAG_LOCATION", ...inFile(root, "src/m/misplaced.ts", "@invariant local") },
    { code: "E_TAG_LOCATION", ...inFile(root, "src/m/misplaced.ts", "@covers miss") },
  ]);
});

test("a type error in a file with an implementation is reported: its types cannot be trusted", (t) => {
  const root = project(t, {
    "src/m/clean-title.ts": CLEAN_FUNCTION,
    "src/m/memory-store.ts": `${STORE_CLASS}\nexport const broken: number = "text";\n`,
    // A file without an implementation is the project's own business, even if it happens to mention a tag.
    "src/m/unrelated.ts": 'export const alsoBroken: number = "text";\n',
    "src/m/mentions.ts": 'export const support: number = "help@tests.example";\n// see @implements in the docs\n',
  });
  assert.deepEqual(
    checkLinking(root).errors.map(({ code, tsCode, file, line }) => ({ code, tsCode, file, line })),
    [{ code: "E_TYPESCRIPT", tsCode: 2322, file: "src/m/memory-store.ts", line: inFile(root, "src/m/memory-store.ts", "broken").line }],
  );
});

test("implementations may live anywhere in the scope, but not in tests or declaration files", (t) => {
  const root = project(t, {
    "src/elsewhere/deep/clean-title.ts": CLEAN_FUNCTION,
    "src/m/store.test.ts": STORE_CLASS,
    "src/m/types.d.ts": "/** @implements Store */\nexport declare class DeclaredStore {}\n",
  });
  const { linking, errors } = checkLinking(root);
  assert.deepEqual(linking.implementations.map((implementation) => [implementation.contract, implementation.location.file]), [["CleanTitle", "src/elsewhere/deep/clean-title.ts"]]);
  // The tag in a test file is misplaced; the declaration file is not read at all.
  assert.deepEqual(errors.map(located), [
    { code: "E_IMPLEMENTATION_MISSING", file: designFile("m"), ...position(root, "interface Store", "interface ".length) },
    { code: "E_TAG_LOCATION", ...inFile(root, "src/m/store.test.ts", "@implements Store") },
  ]);
});

test("source files are read, never executed", (t) => {
  const marker = "executed.txt";
  const sideEffect = `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(marker)}, "x");\nthrow new Error("top-level side effect");\n`;
  const root = project(t, { "src/m/clean-title.ts": `${CLEAN_FUNCTION}${sideEffect}`, "src/m/memory-store.ts": STORE_CLASS });
  fs.appendFileSync(path.join(root, "src/m/contracts.test.ts"), sideEffect);

  const cwd = process.cwd();
  process.chdir(root);
  try {
    // `node:fs` has no types in this project, so the compiler reports the import; nothing else happens.
    assert.deepEqual(checkLinking(root).errors.map(({ code, tsCode }) => ({ code, tsCode })), [{ code: "E_TYPESCRIPT", tsCode: 2591 }]);
  } finally {
    process.chdir(cwd);
  }
  assert.equal(fs.existsSync(path.join(root, marker)), false);
});
