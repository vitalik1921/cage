import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { CheckReport } from "../src/check.ts";
import type { PackageImport } from "../src/design-model.ts";
import type { ReviewIndex, ReviewReport } from "../src/review.ts";
import { declarationDigest, typesDigest } from "../src/package-types.ts";
import { checkDesigns, cli, designProject, editFile, mdx, readFile, writeFile } from "./helpers.ts";

const compilers = ["typescript-5", "typescript"] as const;
const lines = (...items: string[]) => `${items.join("\n")}\n`;
const manifest = (name: string, version: string, types = "index.d.ts") => JSON.stringify({ name, version, types });

function project(t: TestContext, compiler: (typeof compilers)[number], files: Record<string, string>): string {
  const root = designProject(t, {
    port: mdx(lines('import type { Page } from "pw";', "", "/**", " * @contract", " * @final", " * @description Port.", " * @invariant opens Opens a page.", " */", "export interface Port { open(): Page }")),
  }, {
    ".cage/config.json": JSON.stringify({ version: 1, review: "require", coverage: "off" }),
    "src/port/port.ts": lines('import type { Page } from "pw";', "/** @implements Port */", "export class RealPort { open(): Page { throw new Error(); } }"),
    "src/port/port.test.ts": lines('import assert from "node:assert/strict";', 'import { describe, it } from "node:test";', 'import { RealPort } from "./port.ts";', "/** @tests Port */", 'describe("Port", () => {', "  /** @covers opens */", '  it("opens", () => { assert.ok(new RealPort()); });', "});"),
    ...files,
  });
  fs.symlinkSync(path.resolve(import.meta.dirname, "../node_modules", compiler), path.join(root, "node_modules/typescript"), "dir");
  return root;
}

function errors(root: string): string[] {
  const report = JSON.parse(cli(root, "check", "--format", "json").stdout) as CheckReport;
  return report.diagnostics.filter((item) => item.severity === "error").map((item) => item.code);
}

function record(root: string): string {
  const index = JSON.parse(cli(root, "review", "--all", "--format", "json").stdout) as ReviewIndex;
  const report = JSON.parse(cli(root, "review", ...index.contracts.map((item) => item.contract), "--format", "json").stdout) as ReviewReport;
  const verdicts = report.contracts.map(({ contract, fingerprint, invariants }) => ({
    contract, fingerprint,
    findings: invariants.map(({ id }) => ({ invariant: id, assessment: "adequate", reason: "Checked.", evidence: "src/port/port.test.ts:7", suggestedChange: null })),
  }));
  writeFile(root, "verdicts.json", JSON.stringify({ version: 1, verdicts }));
  assert.equal(cli(root, "review", "--record", "verdicts.json").code, 0);
  assert.equal(cli(root, "lock").code, 0);
  assert.deepEqual(errors(root), []);
  return readFile(root, ".cage/lock.json");
}

function expectState(root: string, review: boolean, lock: boolean): void {
  const found = errors(root);
  assert.deepEqual(found.filter((code) => code !== "E_REVIEW_STALE" && code !== "E_LOCK_VIOLATION"), []);
  assert.equal(found.includes("E_REVIEW_STALE"), review, found.join(", "));
  assert.equal(found.includes("E_LOCK_VIOLATION"), lock, found.join(", "));
}

/** @tests Cli
 * @covers package-types review-stale locks */
test("merged declarations, computed keys and global contributors stale reviews and break locks", (t) => {
  for (const compiler of compilers) {
    for (const [label, declaration, contribution, changed] of [
      ["merged", "export interface Page { url():string }", 'import "pw"; declare module "pw" { interface Page { addon:string } }', 'import "pw"; declare module "pw" { interface Page { addon:number } }'],
      ["computed", "export interface Page { [cageAuditKey]:string }", "declare const cageAuditKey: unique symbol;", 'declare const cageAuditKey: "replacement";'],
      ["global", "export type Page = typeof globalThis;", "declare var cageAuditGlobal: { value:string };", "declare var cageAuditGlobal: { value:number };"],
    ]) {
      const root = project(t, compiler, {
        "node_modules/pw/package.json": manifest("pw", "1.0.0"),
        "node_modules/pw/index.d.ts": `${declaration}\n`,
        "node_modules/@types/plugin/package.json": manifest("@types/plugin", "1.0.0"),
        "node_modules/@types/plugin/index.d.ts": `${contribution}\n`,
        "tsconfig.json": JSON.stringify({ compilerOptions: {
          target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true,
          skipLibCheck: true, types: ["plugin"],
        } }),
      });
      record(root);
      writeFile(root, "node_modules/@types/plugin/index.d.ts", `${changed}\n`);
      expectState(root, true, true);
      const packet = JSON.parse(cli(root, "review", "Port", "--format", "json", "--files", "all").stdout) as ReviewReport;
      assert.ok(packet.files.some((file) => file.path === "node_modules/@types/plugin/index.d.ts" && file.text?.includes(changed)), `${compiler}: ${label} changed material shown`);
    }
  }
});

/** @tests Cli
 * @covers package-types locks */
test("retargeting a package entry with an unchanged declaration set stales review and breaks a final lock", (t) => {
  for (const compiler of compilers) {
    const root = project(t, compiler, {
      "node_modules/pw/package.json": manifest("pw", "1.0.0", "a.d.ts"),
      "node_modules/pw/a.d.ts": lines('import type {} from "./b.js";', "export interface Page { url(): string }"),
      "node_modules/pw/b.d.ts": lines('import type {} from "./a.js";', "export interface Page { url(): number }"),
    });
    const lock = record(root);
    editFile(root, "node_modules/pw/package.json", (text) => text.replace("a.d.ts", "b.d.ts"));
    expectState(root, true, true);
    assert.equal(readFile(root, ".cage/lock.json"), lock);
  }
});

/** @tests Cli
 * @covers package-types locks */
test("retargeting a transitive package binding with unchanged declaration text breaks the lock", (t) => {
  for (const compiler of compilers) {
    const root = project(t, compiler, {
      "node_modules/pw/package.json": manifest("pw", "1.0.0"),
      "node_modules/pw/index.d.ts": lines('import type { Value } from "dep";', "export interface Page { value: Value }"),
      "node_modules/dep/package.json": manifest("dep", "1.0.0", "a.d.ts"),
      "node_modules/dep/a.d.ts": lines('import type {} from "./b.js";', "export interface Value { a: string }"),
      "node_modules/dep/b.d.ts": lines('import type {} from "./a.js";', "export interface Value { b: string }"),
    });
    record(root);
    editFile(root, "node_modules/dep/package.json", (text) => text.replace("a.d.ts", "b.d.ts"));
    expectState(root, true, true);
  }
});

/** @tests Cli
 * @covers package-types locks */
test("a version-only update leaves a lock holding while changing the review's package metadata", (t) => {
  for (const compiler of compilers) {
    const root = project(t, compiler, {
      "node_modules/pw/package.json": manifest("pw", "1.0.0"),
      "node_modules/pw/index.d.ts": "export interface Page { url(): string }\n",
    });
    record(root);
    editFile(root, "node_modules/pw/package.json", (text) => text.replace("1.0.0", "2.0.0"));
    expectState(root, true, false);
  }
});

/** @tests Cli
 * @covers package-types locks */
test("edits to an unrelated installed package leave review and lock current", (t) => {
  for (const compiler of compilers) {
    const root = project(t, compiler, {
      "node_modules/pw/package.json": manifest("pw", "1.0.0"),
      "node_modules/pw/index.d.ts": "export interface Page { url(): string }\n",
      "node_modules/other/package.json": manifest("other", "1.0.0"),
      "node_modules/other/index.d.ts": "export interface Spare { size: string }\n",
    });
    record(root);
    editFile(root, "node_modules/other/index.d.ts", (text) => text.replace("size: string", "size: number"));
    expectState(root, false, false);
  }
});

/** @tests Cli
 * @covers package-types locks review-code-trivia */
test("ordinary declaration spacing leaves both records current", (t) => {
  for (const compiler of compilers) {
    const root = project(t, compiler, {
      "node_modules/pw/package.json": manifest("pw", "1.0.0"),
      "node_modules/pw/index.d.ts": "export interface Page { url(): string }\n",
    });
    record(root);
    editFile(root, "node_modules/pw/index.d.ts", (text) => text.replace("{ url(): string }", "{\n  url(): string\n}"));
    expectState(root, false, false);
  }
});

/** @tests Cli
 * @covers package-types locks */
test("both versions of a transitive dependency contribute to the lock", (t) => {
  for (const compiler of compilers) {
    const root = project(t, compiler, {
      "node_modules/pw/package.json": manifest("pw", "1.0.0"),
      "node_modules/pw/index.d.ts": lines('import type { Mid } from "mid";', 'import type { Dep } from "dep";', "export interface Page { mid: Mid; dep: Dep }"),
      "node_modules/pw/node_modules/dep/package.json": manifest("dep", "2.0.0"),
      "node_modules/pw/node_modules/dep/index.d.ts": "export interface Dep { v2: string }\n",
      "node_modules/mid/package.json": manifest("mid", "1.0.0"),
      "node_modules/mid/index.d.ts": lines('import type { Dep } from "dep";', "export interface Mid { d: Dep }"),
      "node_modules/dep/package.json": manifest("dep", "1.0.0"),
      "node_modules/dep/index.d.ts": "export interface Dep { v1: string }\n",
    });
    record(root);
    editFile(root, "node_modules/dep/index.d.ts", (text) => text.replace("v1: string", "v1: number"));
    expectState(root, true, true);
  }
});

/** @tests Cli
 * @covers package-types locks */
test("physical copies with the same package version remain separate review material", (t) => {
  for (const compiler of compilers) {
    const root = project(t, compiler, {
      "node_modules/pw/package.json": manifest("pw", "1.0.0"),
      "node_modules/pw/index.d.ts": lines('import type { Mid } from "mid";', 'import type { Dep } from "dep";', "export interface Page { mid: Mid; dep: Dep }"),
      "node_modules/pw/node_modules/dep/package.json": manifest("dep", "1.0.0"),
      "node_modules/pw/node_modules/dep/index.d.ts": "export interface Dep { nested: string }\n",
      "node_modules/mid/package.json": manifest("mid", "1.0.0"),
      "node_modules/mid/index.d.ts": lines('import type { Dep } from "dep";', "export interface Mid { d: Dep }"),
      "node_modules/dep/package.json": manifest("dep", "1.0.0"),
      "node_modules/dep/index.d.ts": "export interface Dep { hoisted: string }\n",
    });
    record(root);
    const packet = JSON.parse(cli(root, "review", "Port", "--format", "json").stdout) as ReviewReport;
    const matching = packet.files.filter((file) => file.path.includes("dep/index.d.ts"));
    assert.equal(matching.length, 2, `${compiler}: both physical copies should appear in the packet`);
    editFile(root, "node_modules/dep/index.d.ts", (text) => text.replace("hoisted: string", "hoisted: number"));
    expectState(root, true, true);
  }
});

/** @tests Cli
 * @covers package-types locks */
test("routing between same-version physical copies changes review and lock even when both stay selected", (t) => {
  for (const compiler of compilers) {
    const root = project(t, compiler, {
      "node_modules/pw/package.json": manifest("pw", "1.0.0"),
      "node_modules/pw/index.d.ts": lines(
        'import type { Dep as Nested } from "./node_modules/dep/index.js";',
        'import type { Dep as Hoisted } from "../dep/index.js";',
        'import type { Dep as Chosen } from "choice";',
        "export interface Page { nested: Nested; hoisted: Hoisted; chosen: Chosen }",
      ),
      "node_modules/pw/node_modules/dep/package.json": manifest("dep", "1.0.0"),
      "node_modules/pw/node_modules/dep/index.d.ts": "export interface Dep { nested: string }\n",
      "node_modules/dep/package.json": manifest("dep", "1.0.0"),
      "node_modules/dep/index.d.ts": "export interface Dep { hoisted: string }\n",
    });
    const config = JSON.parse(readFile(root, "tsconfig.json")) as { compilerOptions: Record<string, unknown> };
    config.compilerOptions.baseUrl = ".";
    config.compilerOptions.paths = { choice: ["node_modules/pw/node_modules/dep/index.d.ts"] };
    writeFile(root, "tsconfig.json", JSON.stringify(config));
    record(root);
    const before = checkDesigns(root).index.packages[0];
    const fileSet = (files: typeof before.files) => files.map(({ id, file, digest }) => [id, file, digest]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    editFile(root, "tsconfig.json", (text) => text.replace("node_modules/pw/node_modules/dep/index.d.ts", "node_modules/dep/index.d.ts"));
    const after = checkDesigns(root).index.packages[0];
    assert.equal(after.resolution, before.resolution);
    assert.deepEqual(fileSet(after.files), fileSet(before.files));
    expectState(root, true, true);
  }
});

/** @tests Cli
 * @covers package-types locks */
test("old package lock values require a visible migration", (t) => {
  for (const compiler of compilers) {
    const root = project(t, compiler, {
      "node_modules/pw/package.json": manifest("pw", "1.0.0"),
      "node_modules/pw/index.d.ts": "export interface Page { url(): string }\n",
    });
    const current = record(root);
    writeFile(root, ".cage/lock.json", current.replace(/sha256:types-v2:[0-9a-f]{64}/, `sha256:${"0".repeat(64)}`));
    expectState(root, false, true);
    assert.match(cli(root, "check", "--format", "json").stdout, /earlier digest that omitted package routing/);
  }
});

/** @tests Cli
 * @covers package-types review-code-trivia */
test("declaration digest tracks compiler directives and ignores ordinary spacing", () => {
  for (const compiler of compilers) {
    const ts = requireCompiler(compiler);
    const digest = (source: string) => declarationDigest(ts, ts.createSourceFile("index.d.ts", source, ts.ScriptTarget.Latest, true));
    assert.equal(digest("export interface Page { url(): string }\n"), digest("export  interface Page {\n url(): string\n}\n"));
    assert.notEqual(digest("// @ts-ignore\nexport type Page = Missing;\n"), digest("export type Page = Missing;\n"));
    assert.notEqual(digest("// @ts-ignorefoo\nexport type Page = Missing;\n"), digest("export type Page = Missing;\n"));
    assert.notEqual(digest("// @ts-ignore\nexport type Page = Missing;\n"), digest("// @ts-ignore\n\nexport type Page = Missing;\n"));
    assert.equal(digest("// @ts-ignore\nexport type Page = Missing;\n"), digest("// ordinary prose\n// @ts-ignore\nexport type Page = Missing;\n"));
    assert.notEqual(digest('/// <reference lib="dom" />\nexport interface Page {}\n'), digest("export interface Page {}\n"));
    assert.notEqual(digest('/// <reference no-default-lib="true" />\nexport interface Page {}\n'), digest("export interface Page {}\n"));
  }
});

/** @tests Cli
 * @covers package-types locks */
test("pnpm package and peer version-only path changes preserve locks, while physical routing stays distinct", () => {
  const entry = (version: string, peer: string, location: string): PackageImport => {
    const file = `node_modules/.pnpm/dep@${version}_peer@${peer}/node_modules/dep/index.d.ts`;
    return {
      module: "src/port", specifier: "dep", name: "dep", version, directory: file.slice(0, -"/index.d.ts".length),
      resolution: `dep@${version}/index.d.ts`, resolutionFile: `${location}/${file}`, names: ["Dep"], declarations: [],
      files: [{ id: `dep@${version}/index.d.ts`, file: `${location}/${file}`, digest: "sha256:same", text: "export interface Dep {}", routing: [JSON.stringify(["ImportDeclaration", "peer", "1", `peer@${peer}/index.d.ts`, `${location}/node_modules/.pnpm/peer@${peer}/node_modules/peer/index.d.ts`])] }],
      location: { file: "src/port/port.cage.mdx", line: 1, column: 1 },
    };
  };
  assert.equal(typesDigest([entry("1.0.0", "2.0.0", "")]), typesDigest([entry("1.1.0", "2.1.0", "")]));
  assert.notEqual(typesDigest([entry("1.0.0", "2.0.0", "")]), typesDigest([entry("1.0.0", "2.0.0", "nested")]));
  const copyA = entry("1.0.0", "2.0.0", "").files[0];
  const copyB = entry("1.0.0", "3.0.0", "").files[0];
  const routed = (target: string): PackageImport => ({
    ...entry("1.0.0", "2.0.0", ""),
    name: "pw", specifier: "pw", resolution: "pw@1.0.0/index.d.ts", resolutionFile: "node_modules/pw/index.d.ts",
    files: [
      { id: "pw@1.0.0/index.d.ts", file: "node_modules/pw/index.d.ts", digest: "sha256:root", text: "export interface Page {}", routing: [JSON.stringify(["ImportDeclaration", "choice", "1", "dep@1.0.0/index.d.ts", target])] },
      copyA, copyB,
    ],
  });
  assert.notEqual(typesDigest([routed(copyA.file)]), typesDigest([routed(copyB.file)]));
});

function requireCompiler(name: (typeof compilers)[number]): typeof import("typescript") {
  const resolved = path.resolve(import.meta.dirname, "../node_modules", name, "lib/typescript.js");
  // Both installed compiler versions are ESM-importable through createRequire, without changing the project's compiler.
  return compilerRequire(resolved);
}

import { createRequire } from "node:module";
const compilerRequire = createRequire(import.meta.url);
