import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { cli, contract, designProject, editFile, mdx, writeFile } from "./helpers.ts";
import type { CheckReport } from "../src/check.ts";
import type { ReviewReport } from "../src/review.ts";

const compilers = ["typescript-5", "typescript"] as const;
function project(t: TestContext, compiler: string, files: Record<string, string> = {}) {
  const root = designProject(t, { reader: mdx('import type { Page } from "browser-api";', contract("Reader", "read(page: Page): void;")) }, {
    ".cage/config.json": JSON.stringify({ version: 1, review: "off", coverage: "off", designImportableTypes: ["src/types.ts#Database"] }),
    "src/types.ts": "export interface Database { id: string }\n",
    "src/globals.ts": "export {};\ndeclare global { interface Window { cageState: { id: string } } }\n",
    "src/reader/impl.ts": 'import type { Page } from "browser-api";\n/** @implements Reader */\nexport class Reader { read(page: Page): void {} }\n',
    "node_modules/browser-api/package.json": JSON.stringify({ name: "browser-api", version: "1.0.0", types: "index.d.ts" }),
    "node_modules/browser-api/index.d.ts": "export interface Page { window: Window }\n",
    ...files,
  });
  fs.symlinkSync(path.resolve("node_modules", compiler), path.join(root, "node_modules/typescript"), "dir");
  return root;
}
const errors = (root: string) => (JSON.parse(cli(root, "check", "--format", "json").stdout) as CheckReport).diagnostics.filter((d) => d.severity === "error");
const packet = (root: string) => JSON.parse(cli(root, "review", "Reader", "--format", "json", "--files", "all").stdout) as ReviewReport;

/** @tests Cli
 * @covers package-types project-vocabulary exact-signatures gate */
test("an unused type designation and project Window augmentation do not reject package imports", (t) => {
  for (const compiler of compilers) {
    const root = project(t, compiler);
    assert.deepEqual(errors(root), [], compiler);
    assert.equal(cli(root, "gate").code, 0);
    assert.ok(packet(root).files.some((f) => f.path === "src/globals.ts"), compiler);
    editFile(root, "src/reader/impl.ts", (s) => s.replace("read(page: Page)", "read(page: string)"));
    assert.ok(errors(root).some((d) => ["E_TYPE_MISMATCH", "E_CONTRACT_SIGNATURE"].includes(d.code)), compiler);
  }
});

/** @tests Cli
 * @covers package-types */
test("script globals and global namespaces contribute package material without a module import", (t) => {
  for (const compiler of compilers) {
    for (const [global, type] of [
      ["interface Window { cageState: { id: string } }", "Window"],
      ["declare namespace CageGlobals { interface State { id: string } }", "CageGlobals.State"],
      ["export {}; declare global { namespace CageGlobals { interface State { id: string } } }", "CageGlobals.State"],
      ["export {}; declare global { var cageState: { id: string } }", "typeof globalThis.cageState"],
      ['import * as types from "./types.ts"; declare global { namespace CageGlobals { export import Database = types.Database; } }', "CageGlobals.Database"],
    ]) {
      const root = project(t, compiler, { "src/globals.ts": "", "src/ambient.d.ts": global, "node_modules/browser-api/index.d.ts": `export interface Page { window: ${type} }\n` });
      assert.deepEqual(errors(root), [], `${compiler}: ${global}`);
      assert.ok(packet(root).files.some((f) => f.path === "src/ambient.d.ts"));
    }
  }
});

/** @tests Cli
 * @covers package-types project-vocabulary locks review-stale */
test("global augmentation helpers enter review and lock material beyond ordinary dependency bounds", (t) => {
  for (const compiler of compilers) {
    const root = project(t, compiler, {
      "src/globals.ts": 'import type { State } from "./state.ts";\nexport {};\ndeclare global { interface Window { cageState: State } }\n',
      "src/state.ts": 'import { seed } from "./seed.ts";\nexport type State = typeof seed;\n',
      "src/seed.ts": 'export const seed = { kind: "text" as const };\n',
    });
    editFile(root, ".cage/config.json", (s) => JSON.stringify({ ...JSON.parse(s), review: "require", reviewDependencies: { depth: 0, maxFiles: 0 } }));
    const before = packet(root);
    assert.equal(before.complete, true, JSON.stringify(before.diagnostics));
    for (const file of ["src/globals.ts", "src/state.ts", "src/seed.ts"]) assert.ok(before.files.some((f) => f.path === file), file);
    writeFile(root, "verdict.json", JSON.stringify({ version: 1, verdicts: before.contracts.map((c) => ({ contract: c.contract, fingerprint: c.fingerprint, findings: [{ invariant: null, assessment: "adequate", reason: "Fixture attestation used only to test invalidation.", evidence: "src/reader/impl.ts:1", suggestedChange: null }] })) }));
    assert.equal(cli(root, "review", "--record", "verdict.json").code, 0);
    assert.deepEqual(errors(root), []);
    editFile(root, "src/seed.ts", (s) => s.replace('"text"', '"number"'));
    assert.deepEqual(errors(root).map((d) => d.code), ["E_REVIEW_STALE"]);
    editFile(root, "src/reader/reader.cage.mdx", (s) => s.replace("@contract", "@contract\n * @final"));
    assert.equal(cli(root, "lock").code, 0);
    editFile(root, "src/seed.ts", (s) => s.replace('"number"', '"boolean"'));
    assert.ok(errors(root).some((d) => d.code === "E_LOCK_VIOLATION"));
  }
});

/** @tests Cli
 * @covers package-types project-vocabulary */
test("package module imports and reference directives into project files remain rejected, even beside a global contribution", (t) => {
  for (const compiler of compilers) {
    const root = project(t, compiler, {
      "src/globals.ts": "export interface Private { id: string }\ndeclare global { interface Window { cageState: Private } }\n",
    });
    for (const declaration of [
      'import type { Private } from "../../src/globals.js";\nexport interface Page { window: Window; direct: Private }',
      'export interface Page { window: Window; direct: import("../../src/globals.js").Private }',
      'export type { Private as Page } from "../../src/globals.js";',
      '/// <reference path="../../src/globals.ts" />\nexport interface Page { window: Window }',
      'import "../../src/globals.js";\nexport interface Page { window: Window }',
    ]) {
      writeFile(root, "node_modules/browser-api/index.d.ts", declaration);
      const diagnostics = errors(root);
      assert.ok(diagnostics.some((d) => d.code === "E_DESIGN_IMPORT" && d.message.includes("not inside an installed package")), `${compiler}: ${declaration}: ${JSON.stringify(diagnostics)}`);
    }
  }
});

/** @tests Cli
 * @covers package-types project-vocabulary contract-families */
test("designated aliases and enums and concrete family members coexist with a globally augmented package type", (t) => {
  for (const compiler of compilers) {
    const root = project(t, compiler, {
      ".cage/config.json": JSON.stringify({ version: 1, review: "off", coverage: "require", designImportableTypes: ["src/types.ts#Database", "src/types.ts#Status"] }),
      "src/types.ts": 'export type Database = { id: string };\nexport enum Status { Ready = "ready" }\n',
      "src/reader/reader.cage.mdx": mdx('import type { Page } from "browser-api";\nimport type { Database, Status } from "../types.ts";', contract("Base", "read(page: Page, db: Database, status: Status): Database;").replace("@contract", "@family"), contract("Reader extends Base", "")),
      "src/reader/impl.ts": 'import type {Page} from "browser-api";\nimport type {Database, Status} from "../types.ts";\n/** @implements Reader */\nexport class Reader { read(page: Page, db: Database, status: Status): Database { return db; } }',
    });
    assert.deepEqual(errors(root), [], compiler);
    assert.equal(cli(root, "gate").code, 0);
    editFile(root, "src/reader/impl.ts", (s) => s.replace("status: Status", "status: string"));
    assert.ok(errors(root).some((d) => ["E_TYPE_MISMATCH", "E_CONTRACT_SIGNATURE"].includes(d.code)));
  }
});

/** @tests Cli
 * @covers package-types */
test("following an augmentation into another package never authorizes that package's own source imports", (t) => {
  for (const compiler of compilers) {
    const root = project(t, compiler, {
      "src/globals.ts": 'import type { State } from "state-api";\nexport {};\ndeclare global { interface Window { cageState: State } }',
      "node_modules/state-api/package.json": JSON.stringify({ name: "state-api", version: "1.0.0", types: "index.d.ts" }),
      "node_modules/state-api/index.d.ts": 'import type { Database } from "../../src/types.js";\nexport interface State { db: Database }',
    });
    assert.ok(errors(root).some((d) => d.code === "E_DESIGN_IMPORT" && d.message.includes("not inside an installed package")), compiler);
  }
});
