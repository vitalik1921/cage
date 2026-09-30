import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { CheckReport } from "../src/check.ts";
import type { Diagnostic } from "../src/diagnostic.ts";
import type { LockReport } from "../src/lock-command.ts";
import { LOCK_FILE } from "../src/locks.ts";
import { checkDesigns, cli, contract, data, designFile, designProject, editFile, inFile, isError, located, mdx, readFile, snapshot, writeFile } from "./helpers.ts";

const QUOTA = contract("Quota", "take(account: AccountId): boolean;\n  left(account: AccountId): number;", "@final", "@invariant empty Порожня квота відмовляє.");
const STORE = contract("Store", "get(key: string): string | null;", "@extendable", "@invariant miss Невідомий ключ дає null.");
const ACCOUNT_ID = data("AccountId").replace(" * @data", " * @data\n * @final");
const ROW = ["/**", " * @data", " * @description Row.", " * @extendable", " */", "export interface Row {", "  id: string;", "}"].join("\n");

function project(t: TestContext): string {
  return designProject(t, { m: mdx(ACCOUNT_ID, QUOTA, STORE, ROW, contract("Open", "run(): void;", "@invariant ok Працює.")) });
}

function lock(root: string): { code: number; report: LockReport } {
  const { code, stdout, stderr } = cli(root, "lock", "--format", "json");
  assert.equal(stderr, "");
  return { code, report: JSON.parse(stdout) };
}

const position = (root: string, needle: string, offset = 0) => inFile(root, designFile("m"), needle, offset);
/** What `design check --phase design` reports: the design phase, then the locks. */
function diagnosticsOf(root: string): Diagnostic[] {
  const { stdout, stderr } = cli(root, "check", "--phase", "design", "--format", "json");
  assert.equal(stderr, "");
  return (JSON.parse(stdout) as CheckReport).diagnostics;
}
const problems = (root: string) => diagnosticsOf(root).map(({ code, message, file, line, column }) => ({ code, message, file, line, column }));
const change = (root: string, from: string, to: string) => editFile(root, designFile("m"), (s) => s.replace(from, to));

test("a declaration is open unless it is marked: the index records the lock level", (t) => {
  const root = project(t);
  const { index } = checkDesigns(root);
  assert.deepEqual(index.contracts.map(({ name, lock }) => [name, lock]), [["Quota", "final"], ["Store", "extendable"], ["Open", null]]);
  assert.deepEqual(index.data.map(({ name, lock }) => [name, lock]), [["AccountId", "final"], ["Row", "extendable"]]);
  assert.deepEqual(
    index.locked.map(({ name, kind, level, members }) => ({ name, kind, level, members })),
    [
      { name: "AccountId", kind: "data", level: "final", members: { ":type": "string" } },
      { name: "Quota", kind: "contract", level: "final", members: { take: "take(account: AccountId): boolean;", left: "left(account: AccountId): number;" } },
      { name: "Store", kind: "contract", level: "extendable", members: { get: "get(key: string): string | null;" } },
      { name: "Row", kind: "data", level: "extendable", members: { id: "id: string;" } },
    ],
  );
});

test("a marked declaration must be recorded; `design lock` records it and changes nothing afterwards", (t) => {
  const root = project(t);
  assert.deepEqual(
    problems(root).map(({ code, line, column }) => ({ code, line, column })),
    ["type AccountId", "interface Quota", "interface Store", "interface Row"].map((needle) => {
      const { line, column } = position(root, needle, needle.indexOf(" ") + 1);
      return { code: "E_LOCK_MISSING", line, column };
    }),
  );
  assert.equal(cli(root, "check", "--phase", "design").code, 1);
  const before = snapshot(root);

  const first = lock(root);
  assert.equal(first.code, 0);
  assert.deepEqual(first.report, {
    schemaVersion: 1,
    command: "lock",
    ok: true,
    file: LOCK_FILE,
    locks: [
      { module: "src/m", name: "AccountId", kind: "data", level: "final", status: "recorded" },
      { module: "src/m", name: "Quota", kind: "contract", level: "final", status: "recorded" },
      { module: "src/m", name: "Store", kind: "contract", level: "extendable", status: "recorded" },
      { module: "src/m", name: "Row", kind: "data", level: "extendable", status: "recorded" },
    ],
    diagnostics: [],
  });
  assert.deepEqual(Object.keys(snapshot(root)).filter((file) => !(file in before)), [LOCK_FILE]);
  assert.deepEqual(problems(root), []);
  assert.equal(cli(root, "check", "--phase", "design").code, 0);

  const written = readFile(root, LOCK_FILE);
  const modified = fs.statSync(path.join(root, LOCK_FILE), { bigint: true }).mtimeNs;
  const again = lock(root);
  assert.deepEqual(again.report.locks.map((entry) => entry.status), ["unchanged", "unchanged", "unchanged", "unchanged"]);
  assert.equal(readFile(root, LOCK_FILE), written);
  assert.equal(fs.statSync(path.join(root, LOCK_FILE), { bigint: true }).mtimeNs, modified);
  assert.equal(cli(root, "lock").stdout.split("\n").at(-2), `lock: 0 recorded, 0 extended, 4 unchanged in ${LOCK_FILE}.`);
});

test("a @final declaration must not change: not a signature, not a member more or less", (t) => {
  const root = project(t);
  lock(root);
  change(root, "take(account: AccountId): boolean;\n  left(account: AccountId): number;", "take(account: AccountId, amount: number): boolean;\n  refill(account: AccountId): void;");
  change(root, "export type AccountId = string;", "export type AccountId = string | number;");

  assert.deepEqual(problems(root), [
    {
      code: "E_LOCK_VIOLATION",
      message: 'Data type "AccountId" is `@final`: it must not change.\nits type changed; it was: string',
      ...position(root, "type AccountId", "type ".length),
    },
    {
      code: "E_LOCK_VIOLATION",
      message: [
        'Contract "Quota" is `@final`: it must not change.',
        "`take` changed; it was: take(account: AccountId): boolean;",
        "`left` was removed; it was: left(account: AccountId): number;",
        "`refill` was added",
      ].join("\n"),
      ...position(root, "interface Quota", "interface ".length),
    },
  ]);
  // The lock command does not accept the change either: what is recorded stays.
  const recorded = readFile(root, LOCK_FILE);
  assert.equal(lock(root).code, 1);
  assert.equal(readFile(root, LOCK_FILE), recorded);
});

test("an @extendable declaration may grow, and what it has must stay", (t) => {
  const root = project(t);
  lock(root);
  change(root, "  get(key: string): string | null;", "  get(key: string): string | null;\n  put(key: string, value: string): void;");
  change(root, "  id: string;", "  id: string;\n  label?: string;");

  // Additions pass; until they are recorded they are not protected, and the check says so.
  assert.deepEqual(problems(root).map(({ code, message }) => ({ code, message })), [
    { code: "W_LOCK_UNRECORDED", message: 'Contract "Store" has additions that are not locked yet: `put`. Run `design lock` to record them.' },
    { code: "W_LOCK_UNRECORDED", message: 'Data type "Row" has additions that are not locked yet: `label`. Run `design lock` to record them.' },
  ]);
  assert.equal(cli(root, "check", "--phase", "design").code, 0);
  assert.deepEqual(
    lock(root).report.locks.map(({ name, status }) => [name, status]),
    [["AccountId", "unchanged"], ["Quota", "unchanged"], ["Store", "extended"], ["Row", "extended"]],
  );
  assert.deepEqual(problems(root), []);

  change(root, "  get(key: string): string | null;", "  get(key: string): string;");
  change(root, "  label?: string;\n", "");
  assert.deepEqual(problems(root).map(({ code, message }) => ({ code, message })), [
    { code: "E_LOCK_VIOLATION", message: 'Contract "Store" is `@extendable`: what it has must not change; only members may be added.\n`get` changed; it was: get(key: string): string | null;' },
    { code: "E_LOCK_VIOLATION", message: 'Data type "Row" is `@extendable`: what it has must not change; only members may be added.\n`label` was removed; it was: label?: string;' },
  ]);
});

test("formatting, comments and the order of blocks do not break a lock", (t) => {
  const root = project(t);
  lock(root);
  change(root, "take(account: AccountId): boolean;\n  left(account: AccountId): number;", "/** Takes one. */\n  take(\n    account: AccountId\n  ): boolean\n\n  left(account: AccountId): number // how many are left");
  change(root, "# Module", "# Module, with a new title");
  assert.deepEqual(problems(root), []);
});

test("a lock is not lifted by taking the tag off or deleting the declaration", (t) => {
  const root = project(t);
  lock(root);
  change(root, " * @final\n * @invariant", " * @invariant");
  change(root, ["```ts design", STORE, "```", "", ""].join("\n"), "");
  change(root, " * @extendable\n */\nexport interface Row", " * @final\n */\nexport interface Row");

  assert.deepEqual(problems(root), [
    { code: "E_LOCK_VIOLATION", message: `Contract "Store" of src/m is recorded as \`@extendable\` in ${LOCK_FILE}, but it no longer exists.`, file: LOCK_FILE, line: undefined, column: undefined },
    {
      code: "E_LOCK_VIOLATION",
      message: `Contract "Quota" is recorded as \`@final\` in ${LOCK_FILE}, but the tag was taken off. A lock is lifted by removing its entry from the lock file.`,
      ...position(root, "interface Quota", "interface ".length),
    },
    {
      code: "E_LOCK_VIOLATION",
      message: 'Data type "Row" is `@extendable`: what it has must not change; only members may be added.\nit is recorded as `@extendable` and is now marked `@final`',
      ...position(root, "interface Row", "interface ".length),
    },
  ]);

  // Removing the entries by hand is the deliberate way to lift or change a lock.
  const file = JSON.parse(readFile(root, LOCK_FILE));
  writeFile(root, LOCK_FILE, JSON.stringify({ ...file, locks: file.locks.filter((entry: { name: string }) => entry.name === "AccountId") }));
  assert.deepEqual(problems(root).map(({ code }) => code), ["E_LOCK_MISSING"]);
  assert.deepEqual(lock(root).report.locks.map(({ name, status }) => [name, status]), [["AccountId", "unchanged"], ["Row", "recorded"]]);
  assert.deepEqual(problems(root), []);
});

test("lock tags go on contracts and data types, one per declaration, without text", (t) => {
  const root = designProject(t, {
    m: mdx(
      contract("Both", "run(): void;", "@final", "@extendable"),
      contract("Twice", "run(): void;", "@final", "@final"),
      contract("Texted", "run(): void;", "@final forever"),
      contract("Member", "/** @final */\n  run(): void;"),
      data("Alias").replace(" * @data", " * @data\n * @extendable"),
      contract("Fine", "run(): void;", "@extendable"),
    ),
  });
  // The nth line of the document that is exactly this tag line.
  const tagLine = (tag: string, nth: number) => {
    const lines = readFile(root, designFile("m")).split("\n");
    const found = lines.flatMap((line, index) => (line === ` * ${tag}` ? [index + 1] : []));
    return { file: designFile("m"), line: found[nth - 1], column: " * ".length + 1 };
  };
  assert.deepEqual(diagnosticsOf(root).filter(isError).map(located), [
    { code: "E_TAG_FORMAT", ...tagLine("@extendable", 1) },
    { code: "E_TAG_FORMAT", ...tagLine("@final", 3) },
    { code: "E_TAG_FORMAT", ...position(root, "@final forever") },
    { code: "E_TAG_LOCATION", ...position(root, "/** @final */", 4) },
    { code: "E_TAG_LOCATION", ...tagLine("@extendable", 2) },
  ]);
  // With errors in the designs the locks are not compared: a rejected tag is not a lock that was lifted.
  const recorded = project(t);
  lock(recorded);
  change(recorded, " * @final\n * @invariant", " * @final because it is the public API\n * @invariant");
  assert.deepEqual(diagnosticsOf(recorded).map(({ code }) => code), ["E_TAG_FORMAT"]);
});

test("an unusable lock file is a configuration error", (t) => {
  const root = project(t);
  writeFile(root, LOCK_FILE, '{ "version": 2, "locks": [] }');
  assert.deepEqual(problems(root).map(({ code, file }) => ({ code, file })), [{ code: "E_CONFIG", file: LOCK_FILE }]);
  assert.equal(cli(root, "check", "--phase", "design").code, 2);
  assert.equal(lock(root).code, 2);
  assert.equal(readFile(root, LOCK_FILE), '{ "version": 2, "locks": [] }');
});

test("nothing is recorded while a design has errors", (t) => {
  const root = project(t);
  change(root, "get(key: string): string | null;", "get(key: Key): string | null;");
  const { code, report } = lock(root);
  assert.equal(code, 1);
  assert.deepEqual(report.locks, []);
  assert.deepEqual(report.diagnostics.map((diagnostic) => diagnostic.code), ["E_TYPESCRIPT"]);
  assert.equal(fs.existsSync(path.join(root, LOCK_FILE)), false);
});

test("a lock sees members whose names are also names of Object.prototype", (t) => {
  const money = (members: string) => ["/**", " * @data", " * @description Money.", " * @final", " */", "export interface Money {", members, "}"].join("\n");
  const root = designProject(t, { m: mdx(money("  amount: number;"), contract("Thing", "run(): void;", "@invariant ok Працює.")) });
  lock(root);
  change(root, "  amount: number;", "  amount: number;\n  toString(): string;\n  valueOf(): number;\n  constructor: string;\n  __proto__: string;");
  assert.deepEqual(
    problems(root).map(({ code, message }) => ({ code, message })),
    [{ code: "E_LOCK_VIOLATION", message: 'Data type "Money" is `@final`: it must not change.\n`toString` was added\n`valueOf` was added\n`constructor` was added\n`__proto__` was added' }],
  );

  const extendable = designProject(t, { m: mdx(money("  toString(): string;").replace("@final", "@extendable"), contract("Thing", "run(): void;", "@invariant ok Працює.")) });
  assert.deepEqual(JSON.parse(lock(extendable).report.locks.length === 1 ? readFile(extendable, LOCK_FILE) : "{}").locks[0].members, { toString: "toString(): string;" });
});

test("type parameters, a base type and a call signature are not additions to an @extendable declaration", (t) => {
  const root = project(t);
  lock(root);
  change(root, "export interface Row {\n  id: string;\n}", "export interface Row<T> extends Base {\n  id: string;\n  extends: T;\n  (): void;\n}");
  change(root, "export interface Row<T>", "/**\n * @data\n * @description Base.\n */\nexport interface Base {\n  base: string;\n}\n\n/**\n * @data\n * @description Row.\n * @extendable\n */\nexport interface Row<T>");
  change(root, "/**\n * @data\n * @description Row.\n * @extendable\n */\n/**\n * @data\n * @description Base.", "/**\n * @data\n * @description Base.");
  assert.deepEqual(
    problems(root).filter(({ code }) => code.includes("LOCK")).map(({ code, message }) => ({ code, message })),
    [
      {
        code: "E_LOCK_VIOLATION",
        // The property named `extends` is a member like any other; what the interface extends is not.
        message: 'Data type "Row" is `@extendable`: what it has must not change; only members may be added.\nits type parameters was added\nwhat it extends was added\nits call signature was added',
      },
    ],
  );
});

test("a lock compares what the type says, not how it is written", (t) => {
  const kind = (type: string) => data("Kind", type).replace(" * @data", " * @data\n * @final");
  const root = designProject(t, { m: mdx(kind("'a  b' | 'c'"), contract("Thing", "run(): void;", "@invariant ok Працює.")) });
  lock(root);
  assert.equal(JSON.parse(readFile(root, LOCK_FILE)).locks[0].members[":type"], '"a  b" | "c"');

  // Another quote style and layout: the same type.
  change(root, "'a  b' | 'c'", '\n  | "a  b"\n  | "c"');
  assert.deepEqual(problems(root), []);
  // Whitespace inside a string literal is part of the type.
  change(root, '"a  b"', '"a b"');
  assert.deepEqual(problems(root).map(({ code, message }) => ({ code, message })), [
    { code: "E_LOCK_VIOLATION", message: 'Data type "Kind" is `@final`: it must not change.\nits type changed; it was: "a  b" | "c"' },
  ]);
});

test("extract does not look at locks; check and lock do", (t) => {
  const root = project(t);
  assert.equal(cli(root, "extract").code, 0);
  assert.equal(cli(root, "check", "--phase", "design").code, 1);
  lock(root);
  change(root, "take(account: AccountId): boolean;", "take(account: AccountId): number;");
  assert.equal(cli(root, "extract").code, 0);
  assert.equal(cli(root, "check", "--phase", "design").code, 1);
});
