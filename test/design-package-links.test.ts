import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { CheckReport } from "../src/check.ts";
import type { ReviewReport } from "../src/review.ts";
import { cli, contract, editFile, mdx, PROJECT_OPTIONS, readFile, writeFile } from "./helpers.ts";

const repository = path.resolve(import.meta.dirname, "..");
const compilers = ["typescript-5", "typescript"] as const;
const implementation = "src/reader/reader.ts";
const design = "src/reader/reader.cage.mdx";

function fixture(t: TestContext, compiler: (typeof compilers)[number], pnpm = false): { root: string; elsewhere: string } {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "cage-package-links-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "project");
  const elsewhere = path.join(base, "external");
  fs.mkdirSync(elsewhere);
  writeFile(root, "package.json", JSON.stringify({ name: "reader-app", version: "1.0.0", type: "module", dependencies: { "reader-kit": "1.0.0" } }));
  writeFile(root, "tsconfig.json", JSON.stringify({ compilerOptions: { ...PROJECT_OPTIONS, skipLibCheck: true, types: ["node"] } }));
  writeFile(root, ".cage/config.json", JSON.stringify({ version: 1, coverage: "off", review: "require" }));
  writeFile(root, design, mdx('import type { Payload } from "reader-kit";\n' + contract("Reader", "read(): Payload;", "@final", "@invariant reads Returns the expected payload.")));
  writeFile(root, implementation, 'import type { Payload } from "reader-kit";\n/** @implements Reader */\nexport class RealReader { read(): Payload { return { value: "ok" }; } }\n');
  writeFile(root, "src/reader/reader.test.ts", 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { RealReader } from "./reader.ts";\n/** @tests Reader\n * @covers reads */\ntest("reads", () => { assert.deepEqual(new RealReader().read(), {value:"ok"}); });\n');
  const kit = pnpm ? "node_modules/.pnpm/reader-kit@1.0.0/node_modules/reader-kit" : "node_modules/reader-kit";
  const baseKit = pnpm ? "node_modules/.pnpm/base-kit@1.0.0/node_modules/base-kit" : "node_modules/base-kit";
  writeFile(root, `${kit}/package.json`, JSON.stringify({ name: "reader-kit", version: "1.0.0", types: "index.d.ts", dependencies: { "base-kit": "1.0.0" } }));
  writeFile(root, `${kit}/index.d.ts`, 'export type { Payload } from "./types.js";\n');
  writeFile(root, `${kit}/types.d.ts`, 'import type { Value } from "base-kit";\nexport interface Payload { value: Value }\n');
  writeFile(root, `${baseKit}/package.json`, JSON.stringify({ name: "base-kit", version: "1.0.0", types: "index.d.ts" }));
  writeFile(root, `${baseKit}/index.d.ts`, 'export type Value = string;\n');
  if (pnpm) {
    fs.symlinkSync(".pnpm/reader-kit@1.0.0/node_modules/reader-kit", path.join(root, "node_modules/reader-kit"), "dir");
    fs.symlinkSync(".pnpm/base-kit@1.0.0/node_modules/base-kit", path.join(root, "node_modules/base-kit"), "dir");
    fs.symlinkSync("../../base-kit@1.0.0/node_modules/base-kit", path.join(root, "node_modules/.pnpm/reader-kit@1.0.0/node_modules/base-kit"), "dir");
  }
  fs.symlinkSync(path.join(repository, "node_modules", compiler), path.join(root, "node_modules/typescript"), "dir");
  fs.mkdirSync(path.join(root, "node_modules/@types"));
  fs.symlinkSync(path.join(repository, "node_modules/@types/node"), path.join(root, "node_modules/@types/node"), "dir");
  return { root, elsewhere };
}

function packet(root: string): ReviewReport {
  const result = cli(root, "review", "Reader", "--format", "json");
  return JSON.parse(result.stdout) as ReviewReport;
}

function reviewed(root: string): ReviewReport {
  assert.equal(cli(root, "lock").code, 0);
  const before = packet(root);
  const subject = before.contracts[0];
  writeFile(root, "verdicts.json", JSON.stringify({ version: 1, verdicts: [{ contract: "Reader", fingerprint: subject.fingerprint, findings: [{ invariant: "reads", assessment: "adequate", reason: "The assertion compares the returned payload with the expected value.", evidence: "src/reader/reader.test.ts:6", suggestedChange: null }] }] }));
  const record = cli(root, "review", "--record", "verdicts.json");
  assert.equal(record.code, 0, record.stdout);
  assert.equal(cli(root, "gate").code, 0);
  return before;
}

function report(root: string): CheckReport {
  return JSON.parse(cli(root, "check", "--format", "json").stdout) as CheckReport;
}

/** @tests Cli
 * @covers package-types review-stale locks gate exact-signatures */
test("external node_modules links retain the compiler, package review fingerprints, locks and gate verdicts on TS 5 and 6", (t) => {
  for (const compiler of compilers) for (const layout of ["package", "directory", "pnpm"] as const) {
    const { root, elsewhere } = fixture(t, compiler, layout === "pnpm");
    const before = reviewed(root);
    const checked = report(root);
    assert.equal(checked.scope.typescript.source, "project");
    assert.equal(checked.scope.typescript.version, compiler === "typescript-5" ? "5.9.3" : "6.0.3");
    const review = readFile(root, ".cage/review.json");
    const lock = readFile(root, ".cage/lock.json");
    if (layout === "package") {
      fs.renameSync(path.join(root, "node_modules/reader-kit"), path.join(elsewhere, "reader-kit"));
      fs.symlinkSync(path.join(elsewhere, "reader-kit"), path.join(root, "node_modules/reader-kit"), "dir");
      // The linked package resolves its dependency from its physical directory, as Node/TS do.
      fs.mkdirSync(path.join(elsewhere, "reader-kit/node_modules"));
      fs.symlinkSync(path.join(root, "node_modules/base-kit"), path.join(elsewhere, "reader-kit/node_modules/base-kit"), "dir");
    } else {
      fs.renameSync(path.join(root, "node_modules"), path.join(elsewhere, "node_modules"));
      fs.symlinkSync(path.join(elsewhere, "node_modules"), path.join(root, "node_modules"), "dir");
    }
    const after = packet(root);
    assert.equal(after.contracts[0].fingerprint, before.contracts[0].fingerprint, `${compiler} ${layout}`);
    assert.deepEqual(report(root), checked, `${compiler} ${layout}`);
    const gate = cli(root, "gate");
    assert.equal(gate.code, 0, gate.stdout);
    assert.equal(readFile(root, ".cage/review.json"), review);
    assert.equal(readFile(root, ".cage/lock.json"), lock);
    editFile(root, implementation, (text) => text.replace('read(): Payload { return { value: "ok" }; }', 'read(): number { return 1; }'));
    assert.ok(report(root).diagnostics.some(({ code }) => code === "E_TYPE_MISMATCH"));
    assert.equal(cli(root, "gate").code, 2);
    editFile(root, "node_modules/base-kit/index.d.ts", (text) => text.replace("string", "number"));
    assert.notEqual(packet(root).contracts[0].fingerprint, before.contracts[0].fingerprint);
    const locked = JSON.parse(cli(root, "check", "--phase", "design", "--format", "json").stdout) as CheckReport;
    assert.ok(locked.diagnostics.some(({ code }) => code === "E_LOCK_VIOLATION"));
  }
});

/** @tests Cli
 * @covers package-types exact-signatures */
test("external npm aliases retain their declared package identities and detect type drift", (t) => {
  for (const compiler of compilers) {
    const { root, elsewhere } = fixture(t, compiler);
    for (const name of ["left", "right"]) {
      const target = path.join(elsewhere, name);
      writeFile(target, "package.json", JSON.stringify({ name: `${name}-payload-kit`, version: "1.0.0", types: "index.d.ts" }));
      writeFile(target, "index.d.ts", "export interface Payload { value: string }\n");
      fs.symlinkSync(target, path.join(root, "node_modules", name), "dir");
    }
    editFile(root, "package.json", (text) => {
      const manifest = JSON.parse(text);
      manifest.dependencies.left = "npm:left-payload-kit@1.0.0";
      manifest.dependencies.right = "npm:right-payload-kit@1.0.0";
      return JSON.stringify(manifest);
    });
    writeFile(root, design, mdx('import type { Payload } from "left";\nimport type { Payload as Other } from "right";\n' + contract("Reader", "read(): Payload;\n other(): Other;", "@invariant reads Returns the expected payload.")));
    editFile(root, implementation, (text) => text.replace('read(): Payload', 'other(): Payload { return { value: "ok" }; } read(): Payload'));
    const before = packet(root);
    assert.deepEqual(report(root).diagnostics.filter(({ severity, code }) => severity === "error" && code !== "E_REVIEW_MISSING"), []);
    assert.ok(before.files.some(({ path: file }) => file === "node_modules/left/index.d.ts"));
    assert.ok(before.files.some(({ path: file }) => file === "node_modules/right/index.d.ts"));
    editFile(root, "node_modules/right/index.d.ts", (text) => text.replace("value: string", "value: string; required: boolean"));
    assert.notEqual(packet(root).contracts[0].fingerprint, before.contracts[0].fingerprint);
    assert.ok(report(root).diagnostics.some(({ code }) => code === "E_TYPE_MISMATCH"));
    // A link's spelling cannot impersonate a differently named package without its npm alias declaration.
    editFile(root, "package.json", (text) => {
      const manifest = JSON.parse(text);
      delete manifest.dependencies.right;
      return JSON.stringify(manifest);
    });
    assert.ok(report(root).diagnostics.some(({ code }) => code === "E_DESIGN_IMPORT"));
  }
});

/** @tests Cli
 * @covers package-types gate */
test("external packages with library checking retain declaration errors and missing-type errors, including preserveSymlinks", (t) => {
  for (const compiler of compilers) for (const preserveSymlinks of [false, true]) {
    const { root, elsewhere } = fixture(t, compiler);
    editFile(root, "tsconfig.json", (text) => {
      const config = JSON.parse(text);
      config.compilerOptions.preserveSymlinks = preserveSymlinks;
      config.compilerOptions.skipLibCheck = false;
      return JSON.stringify(config);
    });
    assert.equal(cli(root, "lock").code, 0);
    fs.renameSync(path.join(root, "node_modules"), path.join(elsewhere, "node_modules"));
    fs.symlinkSync(path.join(elsewhere, "node_modules"), path.join(root, "node_modules"), "dir");
    const valid = cli(root, "check", "--phase", "design");
    assert.equal(valid.code, 0, valid.stdout);
    editFile(root, "node_modules/base-kit/index.d.ts", (text) => text.replace("string", "MissingName"));
    assert.ok(report(root).diagnostics.some(({ code }) => code === "E_DESIGN_IMPORT"));
    assert.equal(cli(root, "gate").code, 2);
    fs.unlinkSync(path.join(root, "node_modules/base-kit/index.d.ts"));
    assert.ok(report(root).diagnostics.some(({ code }) => code === "E_DESIGN_IMPORT"));
    assert.equal(cli(root, "gate").code, 2);
  }
});
