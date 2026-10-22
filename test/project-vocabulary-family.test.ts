import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { cli, contract, designProject, editFile, mdx, writeFile } from "./helpers.ts";
import type { CheckReport } from "../src/check.ts";
import type { ReviewReport } from "../src/review.ts";

const compilers = ["typescript-5", "typescript"] as const;
function project(t: TestContext, compiler: string, designs: Record<string, string>, files: Record<string, string>) {
  const root = designProject(t, designs, files);
  fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
  fs.symlinkSync(path.resolve("node_modules", compiler), path.join(root, "node_modules/typescript"), "dir");
  return root;
}
const check = (root: string) => JSON.parse(cli(root, "check", "--format", "json", "--max-diagnostics", "all").stdout) as CheckReport;
const errors = (root: string) => check(root).diagnostics.filter((d) => d.severity === "error");
function record(root: string, ...names: string[]) {
  const packet = JSON.parse(cli(root, "review", ...names, "--format", "json", "--files", "all").stdout) as ReviewReport;
  assert.equal(packet.complete, true, JSON.stringify(packet.diagnostics));
  writeFile(root, "verdict.json", JSON.stringify({ version: 1, verdicts: packet.contracts.map((c) => ({ contract: c.contract, fingerprint: c.fingerprint,
    findings: (c.invariants.length ? c.invariants.map((i) => i.id) : [null]).map((invariant) => ({ invariant, assessment: "adequate", reason: "Fixture review to exercise invalidation, not an assessment of product behavior.", evidence: "src/service/impl.ts:1", suggestedChange: null })) })) }));
  const recorded = cli(root, "review", "--record", "verdict.json");
  assert.equal(recorded.code, 0, recorded.stdout);
  return packet;
}
const vocabulary = {
  ".cage/config.json": JSON.stringify({ version: 1, review: "off", coverage: "off", designImportableTypes: ["src/types.ts#Database", "src/types.ts#Status"] }),
  "src/types.ts": 'import { schema } from "./schema.ts";\nexport type Database = { tables: typeof schema };\nexport enum Status { Ready = "ready", Done = "done" }\nexport interface Secret { secret: string }\nexport const runtime = 1;\n',
  "src/schema.ts": 'import { column } from "./column.ts";\nexport const schema = { users: { id: column } };\n',
  "src/column.ts": 'export const column = { type: "text" as const };\n',
  "src/service/impl.ts": 'import type { Database, Status } from "../types.ts";\n/** @implements Service */\nexport class Service { run(db: Database, status: Status): Database { return db; } }\n',
};
const service = mdx('import type { Database, Status } from "../types.ts";', contract("Service", "run(db: Database, status: Status): Database;"));

/** @tests Cli
 * @covers project-vocabulary exact-signatures gate */
test("designated project aliases and enums pass on TS5/6; non-designated and runtime imports and signature drift block", (t) => {
  for (const compiler of compilers) {
    const root = project(t, compiler, { service }, vocabulary);
    assert.deepEqual(errors(root), []);
    assert.equal(cli(root, "gate").code, 0);
    for (const imported of ['import type { Secret } from "../types.ts";', 'import { Database } from "../types.ts";', 'import type * as Vocabulary from "../types.ts";']) {
      writeFile(root, "src/service/service.cage.mdx", mdx(imported, contract("Service")));
      assert.ok(errors(root).some((d) => d.code === "E_DESIGN_IMPORT"), imported);
    }
    writeFile(root, "src/service/service.cage.mdx", service);
    editFile(root, "src/service/impl.ts", (s) => s.replace('run(db: Database, status: Status): Database', 'run(db: Database, status: string): Database'));
    assert.ok(errors(root).some((d) => ["E_TYPE_MISMATCH", "E_CONTRACT_SIGNATURE"].includes(d.code)));
    assert.equal(cli(root, "gate").code, 2);
    editFile(root, ".cage/config.json", (s) => s.replace('src/types.ts#Status', 'src/types.ts#runtime'));
    writeFile(root, "src/service/service.cage.mdx", mdx('import type { runtime } from "../types.ts";', contract("Service", "run(): typeof runtime;")));
    assert.ok(errors(root).some((d) => d.code === "E_DESIGN_IMPORT" && d.message.includes("runtime functions")));
  }
});

/** @tests Cli
 * @covers project-vocabulary locks review-stale */
test("project vocabulary follows inferred schema dependencies into reviews and locks even when ordinary review dependencies are disabled", (t) => {
  for (const compiler of compilers) {
    const root = project(t, compiler, { service }, vocabulary);
    editFile(root, ".cage/config.json", (s) => JSON.stringify({ ...JSON.parse(s), review: "require", reviewDependencies: { depth: 0, maxFiles: 0 } }));
    const packet = record(root, "Service");
    assert.ok(packet.files.some((f) => f.path === "src/column.ts"));
    assert.deepEqual(errors(root), []);
    editFile(root, "src/column.ts", (s) => s.replace('"text"', '"number"'));
    assert.deepEqual(errors(root).map((d) => d.code), ["E_REVIEW_STALE"]);
    const changed = JSON.parse(cli(root, "review", "Service", "--format", "json").stdout);
    assert.ok(JSON.stringify(changed).includes('src/column.ts'));
    editFile(root, "src/service/service.cage.mdx", (s) => s.replace('@contract', '@contract\n * @final'));
    assert.equal(cli(root, "lock").code, 0);
    editFile(root, "src/column.ts", (s) => s.replace('"number"', '"boolean"'));
    assert.ok(errors(root).some((d) => d.code === "E_LOCK_VIOLATION"), JSON.stringify(errors(root)));
  }
});

const family = mdx(contract("Payload", "parse(value: string): string;", "@invariant round-trip returns the supplied value").replace("@contract", "@family"), contract("First extends Payload", ""), contract("Second extends Payload", ""));
const familyFiles = {
  ".cage/config.json": JSON.stringify({ version: 1, review: "off", coverage: "require" }),
  "src/service/impl.ts": '/** @implements First */\nexport const first = { parse(value: string): string { return value; } };\n/** @implements Second */\nexport const second = { parse(value: string): string { return value; } };\n',
  "src/service/impl.test.ts": 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport {first, second} from "./impl.ts";\n/** @tests First\n * @covers round-trip */\ntest("first", () => assert.equal(first.parse("hello"), "hello"));\n/** @tests Second\n * @covers round-trip */\ntest("second", () => assert.equal(second.parse("world"), "world"));\n',
};

/** @tests Cli
 * @covers contract-families contract-inheritance review-stale */
test("families share invariants while each concrete child keeps its own implementation, tests and review", (t) => {
  for (const compiler of compilers) {
    const root = project(t, compiler, { service: family }, familyFiles);
    assert.deepEqual(errors(root), []);
    assert.equal(check(root).counts.invariants, 2);
    editFile(root, ".cage/config.json", (s) => s.replace('"off"', '"require"'));
    assert.deepEqual(errors(root).map((d) => d.contract).sort(), ["First", "Second"]);
    record(root, "First", "Second");
    assert.deepEqual(errors(root), []);
    editFile(root, "src/service/service.cage.mdx", (s) => s.replace('returns the supplied value', 'returns the supplied value unchanged'));
    assert.deepEqual(errors(root).filter((d) => d.code === "E_REVIEW_STALE").map((d) => d.contract).sort(), ["First", "Second"]);
    editFile(root, "src/service/impl.test.ts", (s) => s.slice(0, s.indexOf('/** @tests Second')));
    assert.ok(errors(root).some((d) => d.code === "E_TEST_MISSING" && d.contract === "Second"));
    editFile(root, "src/service/impl.ts", (s) => s.replace('export const second = { parse(value: string): string { return value; } }', 'export const second = { parse(value: number): string { return String(value); } }'));
    assert.ok(errors(root).some((d) => d.code === "E_TYPE_MISMATCH" && d.contract === "Second"));
  }
});

/** @tests Cli
 * @covers contract-families contract-inheritance */
test("normal duplicates still block and abstract families cannot be implemented or tested directly", (t) => {
  for (const compiler of compilers) {
    const root = project(t, compiler, { service: family }, familyFiles);
    editFile(root, "src/service/impl.ts", (s) => s.replace('@implements Second', '@implements First'));
    assert.ok(errors(root).some((d) => d.code === "E_IMPLEMENTATION_DUPLICATE"));
    editFile(root, "src/service/impl.ts", (s) => s.replace('@implements First', '@implements Payload'));
    assert.ok(errors(root).some((d) => d.code === "E_FAMILY_BINDING"));
    editFile(root, "src/service/impl.test.ts", (s) => s.replace('@tests First', '@tests Payload'));
    assert.ok(errors(root).some((d) => d.code === "E_REFERENCE_UNKNOWN"));
    assert.notEqual(cli(root, "review", "Payload").code, 0);
  }
});

/** @tests Cli
 * @covers project-vocabulary draft-candidate locks */
test("project vocabulary supports path aliases, type re-exports, project augmentations and draft validation", (t) => {
  for (const compiler of compilers) {
    const root = project(t, compiler, { service: mdx('import type { Database } from "vocabulary";', contract("Service", "run(db:Database):Database;")) }, vocabulary);
    editFile(root, "tsconfig.json", (s) => JSON.stringify({ ...JSON.parse(s), compilerOptions: { ...JSON.parse(s).compilerOptions, paths: { vocabulary: ["./src/types.ts"] }, skipLibCheck: true } }));
    writeFile(root, "src/types.ts", 'export type { Database } from "./domain.ts";');
    writeFile(root, "src/domain.ts", 'export interface Fields { id:string }\nexport type Database = Fields;');
    writeFile(root, "src/augment.ts", 'import "./domain.ts";\ndeclare module "./domain.ts" { interface Fields { extra:number } }');
    writeFile(root, "src/service/impl.ts", 'import type {Database} from "../types.ts";\n/** @implements Service */\nexport class Service {run(db:Database):Database{return db}}');
    assert.deepEqual(errors(root), []);
    const packet = record(root, "Service");
    assert.ok(packet.files.some((file) => file.path === "src/augment.ts"));
    const initial = packet.contracts[0].fingerprint;
    editFile(root, "src/augment.ts", (s) => s.replace('extra:number', 'extra:boolean'));
    assert.notEqual(record(root, "Service").contracts[0].fingerprint, initial);
    assert.equal(cli(root, "draft", "create", "src/service/service.cage.mdx").code, 0);
    const draft = cli(root, "draft", "check", "src/service/service.cage.draft.mdx");
    assert.equal(draft.code, 0, draft.stdout);
    writeFile(root, "src/domain.ts", 'export type Database = MissingSourceType;');
    assert.ok(errors(root).some((d) => d.code === "E_DESIGN_IMPORT"));
  }
});

/** @tests Cli
 * @covers project-vocabulary */
test("a designated source and its transitive dependencies cannot escape the project through symlinks", (t) => {
  for (const compiler of compilers) {
    const root = project(t, compiler, { service }, vocabulary);
    const outside = designProject(t, {}, { "types.ts": 'export interface Database { secret:string }\nexport enum Status { Ready }' });
    fs.rmSync(path.join(root, "src/types.ts"));
    fs.symlinkSync(path.join(outside, "types.ts"), path.join(root, "src/types.ts"));
    assert.ok(errors(root).some((d) => d.code === "E_DESIGN_IMPORT"));
    fs.rmSync(path.join(root, "src/types.ts"));
    writeFile(root, "src/types.ts", vocabulary["src/types.ts"]);
    fs.rmSync(path.join(root, "src/column.ts"));
    writeFile(outside, "column.ts", 'export const column={type:"external"};');
    fs.symlinkSync(path.join(outside, "column.ts"), path.join(root, "src/column.ts"));
    assert.ok(errors(root).some((d) => d.code === "E_DESIGN_IMPORT"));
  }
});

/** @tests ConfigLoader
 * @covers fields */
test("project type allowlists reject globs, parent traversal and malformed export entries", (t) => {
  const root = designProject(t, { service });
  for (const value of [["../types.ts#Type"], ["/src/types.ts#Type"], ["src/*.ts#Type"], ["src/types.ts"], ["src/types.ts#*"], "src/types.ts#Type"]) {
    writeFile(root, ".cage/config.json", JSON.stringify({ version: 1, designImportableTypes: value }));
    assert.equal(cli(root, "check").code, 2, JSON.stringify(value));
  }
});

/** @tests Cli
 * @covers project-vocabulary package-types contract-inheritance exact-surface */
test("explicit imported bases work for designated vocabulary and externally linked library classes without accepting extra project API", (t) => {
  for (const compiler of compilers) {
    const root = project(t, compiler, { service: mdx('import type { Public } from "../types.ts";', contract("Service extends Public", "")) }, {
      ".cage/config.json": JSON.stringify({ version: 1, coverage: "off", review: "off", designImportableTypes: ["src/types.ts#Public"] }),
      "src/types.ts": "export interface Public {run():string}",
      "src/service/impl.ts": '/** @implements Service */\nexport class Service {run():string{return "ok"}}',
    });
    assert.deepEqual(errors(root), []);
    const external = designProject(t, {}, { "package.json": JSON.stringify({ name: "linked-library", version: "1.0.0", types: "index.d.ts" }), "index.d.ts": "export declare class Public {run():string}" });
    fs.symlinkSync(external, path.join(root, "node_modules/linked-library"));
    writeFile(root, "src/service/service.cage.mdx", mdx('import type {Public} from "linked-library";', contract("Service extends Public", "")));
    assert.deepEqual(errors(root), []);
    editFile(root, "src/service/impl.ts", (s) => s.replace('class Service {', 'class Service {extra():void{} '));
    assert.ok(errors(root).some((d) => d.code === "E_CONTRACT_EXTRA_MEMBER"));
  }
});
