import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { CheckReport } from "../src/check.ts";
import type { ReviewIndex, ReviewReport } from "../src/review.ts";
import { at, checkDesigns, checkLinking, cli, contract, data, designFile, designProject, editFile, located, mdx, readFile, scratchDirectory, writeFile } from "./helpers.ts";

// Designs may take types from installed packages: `import type { Schema } from "schema-kit"`. The packages below are
// synthetic declaration packages in the project's own node_modules; their JavaScript must never run.

const lines = (...text: string[]) => `${text.join("\n")}\n`;
const COMPILERS = ["typescript-5", "typescript"] as const;
const DESIGN = designFile("parser");
const IMPLEMENTATION = "src/parser/parser.ts";
const TESTS = "src/parser/parser.test.ts";
const EXECUTED = "executed.txt";

/** JavaScript of a package that leaves a trace when anything loads it. */
const tripwire = (name: string) => `require("node:fs").writeFileSync(${JSON.stringify(`${EXECUTED}`)}, ${JSON.stringify(name)});\nthrow new Error("${name} was executed");\n`;

const PACKAGES: Record<string, string> = {
  // `exports` with a types condition, an `export *` to a second file and a transitive package.
  "node_modules/schema-kit/package.json": JSON.stringify({
    name: "schema-kit",
    version: "1.2.0",
    exports: { ".": { types: "./index.d.ts", default: "./index.cjs" } },
    scripts: { postinstall: "node index.cjs" },
  }),
  "node_modules/schema-kit/index.cjs": tripwire("schema-kit"),
  "node_modules/schema-kit/index.d.ts": lines('export * from "./types.js";', "export declare const marker: unique symbol;"),
  "node_modules/schema-kit/types.d.ts": lines(
    'import type { Brand } from "brand-kit";',
    "/** A parser of unknown input. */",
    "export interface Schema<T> {",
    "  parse(input: unknown): T;",
    "  brand: Brand;",
    "}",
  ),
  // The older layout: `types` and `main`, no `exports`.
  "node_modules/brand-kit/package.json": JSON.stringify({ name: "brand-kit", version: "0.1.0", main: "index.js", types: "index.d.ts" }),
  "node_modules/brand-kit/index.js": tripwire("brand-kit"),
  "node_modules/brand-kit/index.d.ts": "export type Brand = { readonly tag: string };\n",
};

const PARSER = contract("Parser", "schema: Schema<string>;\n  parse(input: unknown): string;", "@invariant text Parses text.");

/** A project whose design imports a package's types, with an implementation and a test for its one invariant. */
function project(t: TestContext, compiler: (typeof COMPILERS)[number], files: Record<string, string> = {}, design = mdx(`import type { Schema } from "schema-kit";\n\n${PARSER}`)): string {
  const root = designProject(t, { parser: design }, {
    ...PACKAGES,
    [IMPLEMENTATION]: lines(
      'import type { Schema } from "schema-kit";',
      "",
      "/** @implements Parser */",
      "export class TextParser {",
      '  schema: Schema<string> = { parse: (input: unknown): string => String(input), brand: { tag: "text" } };',
      "  parse(input: unknown): string {",
      "    return this.schema.parse(input);",
      "  }",
      "}",
    ),
    [TESTS]: lines(
      'import assert from "node:assert/strict";',
      'import { describe, it } from "node:test";',
      'import { TextParser } from "./parser.ts";',
      "",
      "/** @tests Parser */",
      'describe("Parser", () => {',
      "  /** @covers text */",
      '  it("parses text", () => {',
      '    assert.equal(new TextParser().parse(1), "1");',
      "  });",
      "});",
    ),
    ".cage/config.json": JSON.stringify({ version: 1, review: "require", coverage: "off" }),
    ...files,
  });
  fs.symlinkSync(path.resolve(import.meta.dirname, "../node_modules", compiler), path.join(root, "node_modules/typescript"), "dir");
  return root;
}

const executed = (root: string) => fs.existsSync(path.join(root, EXECUTED)) || fs.existsSync(path.join(process.cwd(), EXECUTED));

function check(root: string): { code: number; report: CheckReport } {
  const { code, stdout } = cli(root, "check", "--format", "json");
  return { code, report: JSON.parse(stdout) };
}

function packets(root: string): ReviewReport {
  const index = JSON.parse(cli(root, "review", "--all", "--format", "json").stdout) as ReviewIndex;
  return JSON.parse(cli(root, "review", ...index.contracts.map((entry) => entry.contract), "--format", "json").stdout);
}

function recordAdequate(root: string): void {
  const verdicts = packets(root).contracts.map(({ contract: name, fingerprint, invariants }) => ({
    contract: name,
    fingerprint,
    findings: invariants.map(({ id }) => ({ invariant: id, assessment: "adequate", reason: "Checked.", evidence: `${TESTS}:8`, suggestedChange: null })),
  }));
  writeFile(root, "verdicts.json", JSON.stringify({ version: 1, verdicts }));
  assert.equal(cli(root, "review", "--record", "verdicts.json").code, 0);
  const fresh = check(root);
  assert.equal(fresh.code, 0, fresh.report.diagnostics.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`).join("\n"));
}

/** The parts of the stale review, or undefined while it is current. */
function staleBecause(root: string, name = "Parser"): string | undefined {
  const { report } = check(root);
  const stale = report.diagnostics.find((diagnostic) => diagnostic.code === "E_REVIEW_STALE" && diagnostic.contract === name);
  return stale && stale.message.split("\n").slice(1).map((line) => line.replace(/^- /, "")).join(", ");
}

/** @tests Cli
 * @covers package-types */
test("a design imports the types of an installed package, with its declaration closure, on TypeScript 5 and 6", (t) => {
  for (const compiler of COMPILERS) {
    const root = project(t, compiler);
    const result = checkDesigns(root);
    assert.equal(result.typescript.source, "project", compiler);
    assert.equal(result.typescript.version.split(".")[0], compiler === "typescript-5" ? "5" : "6");
    assert.deepEqual(result.errors, [], compiler);
    const [entry] = result.index.packages;
    assert.equal(result.index.packages.length, 1);
    assert.deepEqual(
      { module: entry.module, specifier: entry.specifier, name: entry.name, version: entry.version, directory: entry.directory, names: entry.names, location: entry.location },
      { module: "src/parser", specifier: "schema-kit", name: "schema-kit", version: "1.2.0", directory: "node_modules/schema-kit", names: ["Schema"], location: at(root, "parser", "import type") },
    );
    // The closure reaches the transitive package; files are named by package and version, not by where they are installed.
    assert.deepEqual(entry.files.map((file) => [file.id, file.file]), [
      ["brand-kit@0.1.0/index.d.ts", "node_modules/brand-kit/index.d.ts"],
      ["schema-kit@1.2.0/index.d.ts", "node_modules/schema-kit/index.d.ts"],
      ["schema-kit@1.2.0/types.d.ts", "node_modules/schema-kit/types.d.ts"],
    ]);
    assert.ok(entry.files.every((file) => /^sha256:[0-9a-f]{64}$/.test(file.digest)));
    assert.deepEqual(entry.declarations.map(({ name, id, line }) => [name, id, line]), [["Schema", "schema-kit@1.2.0/types.d.ts", 3]]);
    assert.match(entry.declarations[0].text, /^export interface Schema<T> \{\n  parse\(input: unknown\): T;\n  brand: Brand;\n\}$/);

    // The package's types are compared like any other: a schema of numbers is not the promised schema of strings.
    assert.deepEqual(checkLinking(root).errors, [], compiler);
    editFile(root, IMPLEMENTATION, (text) => text.replace("schema: Schema<string> = { parse: (input: unknown): string => String(input)", "schema: Schema<number> = { parse: (input: unknown): number => Number(input)").replace("return this.schema.parse(input);", "return String(this.schema.parse(input));"));
    assert.ok(checkLinking(root).errors.some((diagnostic) => diagnostic.code === "E_TYPE_MISMATCH" || diagnostic.code === "E_CONTRACT_SIGNATURE"), compiler);
    editFile(root, IMPLEMENTATION, (text) => text.replace("schema: Schema<number> = { parse: (input: unknown): number => Number(input)", "schema: Schema<string> = { parse: (input: unknown): string => String(input)").replace("return String(this.schema.parse(input));", "return this.schema.parse(input);"));
    assert.deepEqual(checkLinking(root).errors, [], compiler);
    // And through the transitive package: its Brand is no `any`.
    editFile(root, "node_modules/brand-kit/index.d.ts", (text) => text.replace("readonly tag: string", "readonly tag: number"));
    assert.ok(checkLinking(root).errors.length > 0, compiler);
    assert.equal(executed(root), false, compiler);
  }
});

/** @tests Cli
 * @covers package-types */
test("namespace and default imports name what the design uses; a type error with package types is reported", (t) => {
  const root = project(t, "typescript", {
    "node_modules/brand-kit/index.d.ts": "export type Brand = { readonly tag: string };\ndeclare const brand: Brand;\nexport default brand;\n",
  }, mdx(lines(
    'import type * as kit from "schema-kit";',
    'import type defaultBrand from "brand-kit";',
    "",
    contract("Parser", "schema: kit.Schema<string>;\n  brand: typeof defaultBrand;\n  parse(input: unknown): string;", "@invariant text Parses text."),
  )));
  const result = checkDesigns(root);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.index.packages.map(({ specifier, names }) => [specifier, names]), [["schema-kit", ["Schema"]], ["brand-kit", ["default"]]]);

  editFile(root, DESIGN, (text) => text.replace("kit.Schema<string>", "kit.Missing<string>"));
  assert.deepEqual(checkDesigns(root).errors.map(({ code, tsCode }) => [code, tsCode]), [["E_TYPESCRIPT", 2694]]);
});

/** @tests Cli
 * @covers package-types */
test("package imports are type-only, resolve to installed declarations, and a path alias does not make a project file a package", (t) => {
  for (const compiler of COMPILERS) {
    const root = project(t, compiler, {
      "src/fake/schema-kit.ts": "export interface Schema<T> { parse(input: unknown): T }\nexport const run = () => 1;\n",
      "types/local-kit/index.d.ts": "export interface Schema<T> { parse(input: unknown): T }\n",
      // A package that ships only JavaScript, one that ships TypeScript source, one whose declarations reach its source.
      "node_modules/js-only/package.json": JSON.stringify({ name: "js-only", version: "1.0.0", main: "index.js" }),
      "node_modules/js-only/index.js": tripwire("js-only"),
      "node_modules/ts-source/package.json": JSON.stringify({ name: "ts-source", version: "1.0.0", exports: { ".": "./index.ts" } }),
      "node_modules/ts-source/index.ts": "export interface Schema<T> { parse(input: unknown): T }\n",
      "node_modules/leaky/package.json": JSON.stringify({ name: "leaky", version: "1.0.0", types: "index.d.ts" }),
      "node_modules/leaky/index.d.ts": 'export type { Schema } from "./impl.ts";\n',
      "node_modules/leaky/impl.ts": "export interface Schema<T> { parse(input: unknown): T }\n",
      // A directory in node_modules that is not the package it claims to be.
      "node_modules/impostor/package.json": JSON.stringify({ name: "someone-else", version: "1.0.0", types: "index.d.ts" }),
      "node_modules/impostor/index.d.ts": "export interface Schema<T> { parse(input: unknown): T }\n",
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, allowImportingTsExtensions: true,
          paths: { "fake-kit": ["./src/fake/schema-kit.ts"], "local-kit": ["./types/local-kit/index.d.ts"], "renamed-kit": ["./node_modules/brand-kit/index.d.ts"] },
        },
      }),
    });
    const specifiers = ["fake-kit", "local-kit", "renamed-kit", "js-only", "ts-source", "leaky", "impostor", "not-installed-kit", "schema-kit/missing"];
    editFile(root, DESIGN, (text) => text.replace('import type { Schema } from "schema-kit";', [
      'import { Schema } from "schema-kit";',
      ...specifiers.map((specifier, i) => `import type { Schema as S${i} } from "${specifier}";`),
    ].join("\n")));
    const errors = checkDesigns(root).errors;
    const here = (needle: string) => ({ code: "E_DESIGN_IMPORT", ...at(root, "parser", needle) });
    assert.deepEqual(errors.map(located), [here('import { Schema } from "schema-kit";'), ...specifiers.map((specifier) => here(`"${specifier}"`))], compiler);
    const message = (specifier: string) => errors.find((diagnostic) => diagnostic.message.startsWith(`"${specifier}"`))!.message;
    assert.match(message("fake-kit"), /resolves to src\/fake\/schema-kit\.ts, not to an installed package; a path alias/);
    assert.match(message("local-kit"), /resolves to types\/local-kit\/index\.d\.ts, not to an installed package/);
    assert.match(message("renamed-kit"), /resolves into the package brand-kit, not renamed-kit/);
    assert.match(message("js-only"), /js-only@1\.0\.0\/index\.js, which is not a declaration file|resolves to no installed package's types/);
    assert.match(message("ts-source"), /ts-source@1\.0\.0\/index\.ts, which is not a declaration file/);
    assert.match(message("leaky"), /is not supported: its declarations reach leaky@1\.0\.0\/impl\.ts, which is not a declaration file/);
    assert.match(message("impostor"), /package\.json does not name the package impostor/);
    assert.match(message("not-installed-kit"), /resolves to no installed package's types/);
    assert.match(message("schema-kit/missing"), /resolves to no installed package's types/);
    assert.equal(executed(root), false, compiler);
  }
});

/** @tests Cli
 * @covers package-types */
test("packages installed through node_modules links may live outside the project, but uninstalled files still cannot be imported", (t) => {
  const root = project(t, "typescript");
  const elsewhere = scratchDirectory(t, "linked-package");
  writeFile(elsewhere, "plain/package.json", JSON.stringify({ name: "plain-kit", version: "1.0.0", types: "index.d.ts" }));
  writeFile(elsewhere, "plain/index.d.ts", "export type Secret = string;\n");
  writeFile(elsewhere, "node_modules/nested-kit/package.json", JSON.stringify({ name: "nested-kit", version: "1.0.0", types: "index.d.ts" }));
  writeFile(elsewhere, "node_modules/nested-kit/index.d.ts", "export type Secret = string;\n");
  fs.symlinkSync(path.join(elsewhere, "plain"), path.join(root, "node_modules/plain-kit"), "dir");
  fs.symlinkSync(path.join(elsewhere, "node_modules/nested-kit"), path.join(root, "node_modules/nested-kit"), "dir");
  editFile(root, DESIGN, (text) => text.replace('import type { Schema } from "schema-kit";', 'import type { Schema } from "schema-kit";\nimport type { Secret } from "plain-kit";\nimport type { Secret as Other } from "nested-kit";'));
  assert.deepEqual(checkDesigns(root).errors, []);
  // An installed package does not authorize a relative escape to an uninstalled declaration.
  writeFile(elsewhere, "secret.d.ts", "export type Secret = string;\n");
  writeFile(elsewhere, "plain/index.d.ts", 'export type { Secret } from "../secret.js";\n');
  editFile(root, DESIGN, (text) => text.replace("schema: Schema<string>;", "schema: Schema<string>;\n  secret: Secret;"));
  const errors = checkDesigns(root).errors;
  assert.deepEqual(errors.map(located), [{ code: "E_DESIGN_IMPORT", ...at(root, "parser", '"plain-kit"') }]);
  assert.match(errors[0].message, /not inside an installed package/);
});

/** @tests Cli
 * @covers package-types */
test("every declaration file of an imported package is review material, with its text: a change of it makes the review stale", (t) => {
  for (const compiler of COMPILERS) {
    const root = project(t, compiler, {
      // Another module without package imports: its review does not depend on the package.
      [designFile("other")]: mdx(contract("Other", "run(): void;", "@invariant ok Runs.")),
      "src/other/other.ts": "/** @implements Other */\nexport class RealOther {\n  run(): void {}\n}\n",
      "src/other/other.test.ts": lines('import { it } from "node:test";', 'import { RealOther } from "./other.ts";', "/** @tests Other\n * @covers ok */", 'it("runs", () => { new RealOther().run(); });'),
    });
    const before = packets(root);
    const parser = before.contracts.find((packet) => packet.contract === "Parser")!;
    assert.deepEqual(parser.packages, [{ name: "schema-kit", versions: ["1.2.0"], directory: "node_modules/schema-kit" }]);
    assert.deepEqual(before.contracts.find((packet) => packet.contract === "Other")!.packages, []);
    // The metadata, and every declaration file reached as the compiler read it, the transitive package's among them.
    const packageFiles = Object.fromEntries(before.files.filter((file) => file.role === "package").map((file) => [file.path, file.text]));
    assert.deepEqual(Object.keys(packageFiles).sort(), ["node_modules/brand-kit/index.d.ts", "node_modules/schema-kit", "node_modules/schema-kit/index.d.ts", "node_modules/schema-kit/types.d.ts"]);
    for (const file of ["node_modules/brand-kit/index.d.ts", "node_modules/schema-kit/index.d.ts", "node_modules/schema-kit/types.d.ts"]) assert.equal(packageFiles[file], readFile(root, file), file);
    assert.equal(packageFiles["node_modules/schema-kit"], lines(
      "package schema-kit@1.2.0: types only, never executed",
      'imported by src/parser: "schema-kit" -> schema-kit@1.2.0/index.d.ts (node_modules/schema-kit/index.d.ts); Schema',
      "declared at:",
      "Schema: schema-kit@1.2.0/types.d.ts:3",
      "declaration files (each one in the material):",
      "brand-kit@0.1.0/index.d.ts (node_modules/brand-kit/index.d.ts)",
      "schema-kit@1.2.0/index.d.ts (node_modules/schema-kit/index.d.ts)",
      '  resolves: ["ExportDeclaration","./types.js","1","schema-kit@1.2.0/types.d.ts","node_modules/schema-kit/types.d.ts"]',
      "schema-kit@1.2.0/types.d.ts (node_modules/schema-kit/types.d.ts)",
      '  resolves: ["ImportDeclaration","brand-kit","1","brand-kit@0.1.0/index.d.ts","node_modules/brand-kit/index.d.ts"]',
    ));
    const markdown = cli(root, "review", "Parser").stdout;
    assert.match(markdown, /- package types: schema-kit@1\.2\.0 \(F\d+\)/);
    assert.match(markdown, /### F\d+ \(package\)/);
    assert.ok(markdown.includes("1 | export type Brand = { readonly tag: string };"));
    recordAdequate(root);
    const fingerprint = () => (JSON.parse(cli(root, "review", "Parser", "--format", "json").stdout) as ReviewReport).contracts[0].fingerprint;
    const recorded = fingerprint();

    // Comments and layout of the declarations are not their types.
    editFile(root, "node_modules/brand-kit/index.d.ts", (text) => `/** The brand. */\n${text.replace("{ readonly tag: string }", "{\n  readonly tag: string\n}")}`);
    assert.equal(staleBecause(root), undefined, compiler);
    assert.equal(fingerprint(), recorded, compiler);

    // A change of a helper type in a transitive package, a file without the imported name, changes the contract's types.
    const changedText = editFile(root, "node_modules/brand-kit/index.d.ts", (text) => text.replace("readonly tag: string", "readonly tag: string | number"));
    assert.notEqual(fingerprint(), recorded, compiler);
    assert.equal(staleBecause(root), "declaration file brand-kit@0.1.0/index.d.ts changed", compiler);
    assert.equal(staleBecause(root, "Other"), undefined, compiler);
    const index = JSON.parse(cli(root, "review", "--format", "json").stdout) as ReviewIndex;
    assert.deepEqual(index.contracts.map(({ contract: name, changed }) => [name, changed]), [
      ["Parser", [{ part: "declaration brand-kit@0.1.0/index.d.ts", kind: "declaration", change: "changed", file: "node_modules/brand-kit/index.d.ts", name: "brand-kit@0.1.0/index.d.ts" }]],
    ]);
    // The reviewer reads the changed source itself, by default and with every file.
    for (const files of [[], ["--files", "all"]]) {
      const report = JSON.parse(cli(root, "review", "Parser", ...files, "--format", "json").stdout) as ReviewReport;
      assert.equal(report.contracts[0].recordedReview.status, "outdated");
      assert.equal(report.files.find((file) => file.path === "node_modules/brand-kit/index.d.ts")?.text, changedText, `${compiler} ${files.join(" ")}`);
      assert.ok(cli(root, "review", "Parser", ...files).stdout.includes("readonly tag: string | number"), `${compiler} ${files.join(" ")}`);
    }
    const gate = cli(root, "gate");
    assert.match(gate.stdout + gate.stderr, /package declaration file/);
    recordAdequate(root);

    // A new version of the package is other material, even with the same declarations.
    editFile(root, "node_modules/schema-kit/package.json", (text) => text.replace('"1.2.0"', '"1.2.1"'));
    assert.match(staleBecause(root) ?? "", /the types of package schema-kit changed/, compiler);
    recordAdequate(root);

    // So is a package newly imported.
    editFile(root, DESIGN, (text) => text.replace('import type { Schema } from "schema-kit";', 'import type { Schema } from "schema-kit";\nimport type { Brand } from "brand-kit";'));
    assert.equal(staleBecause(root), "the types of package brand-kit is new", compiler);
    assert.equal(executed(root), false, compiler);
  }
});

/** @tests Cli
 * @covers package-types */
test("missing selected package declarations follow skipLibCheck; ambient modules and globals are followed", (t) => {
  for (const compiler of COMPILERS) {
    const options = { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, allowImportingTsExtensions: true, skipLibCheck: true, types: ["node"] };
    const root = project(t, compiler, { "tsconfig.json": JSON.stringify({ compilerOptions: options }) });
    const missing = [
      'import type { Gone } from "./gone.js";\nexport type Brand = { readonly tag: Gone };',
      'export type Brand = { readonly tag: import("./index.js").Gone };',
      "export type Brand = { readonly tag: NoSuchGlobal };",
      '/// <reference types="no-such-types" />\nexport type Brand = { readonly tag: string };',
    ];
    for (const line of missing) {
      // The dependency occurs in Brand, the declaration selected by Schema's public type.
      writeFile(root, "node_modules/brand-kit/index.d.ts", `${line}\n`);
      writeFile(root, "tsconfig.json", JSON.stringify({ compilerOptions: options }));
      assert.deepEqual(checkDesigns(root).errors, [], `${compiler} ${line}`);
      assert.equal(cli(root, "check", "--phase", "design").code, 0);
      writeFile(root, "tsconfig.json", JSON.stringify({ compilerOptions: { ...options, skipLibCheck: false } }));
      const errors = checkDesigns(root).errors;
      assert.deepEqual(errors.map(located), [{ code: "E_DESIGN_IMPORT", ...at(root, "parser", '"schema-kit"') }], `${compiler} ${line}`);
      assert.match(errors[0].message, /^"schema-kit" (?:has an error in a selected declaration|has an unresolved selected declaration): /);
      // Blocked, not merely reported: the check fails and nothing is reviewed.
      assert.equal(cli(root, "check").code, 1);
    }
    writeFile(root, "tsconfig.json", JSON.stringify({ compilerOptions: options }));

    // An ambient module and a global of an installed package: their declaration files are in the closure.
    writeFile(root, "node_modules/brand-kit/index.d.ts", 'import type { Stats } from "node:fs";\nexport type Brand = { readonly tag: string; stats?: Stats; bytes?: Buffer };\n');
    const result = checkDesigns(root);
    assert.deepEqual(result.errors, [], compiler);
    const ids = result.index.packages[0].files.map((file) => file.id);
    assert.ok(ids.some((id) => /^@types\/node@[^/]+\/fs\.d\.ts$/.test(id)), `${compiler}: ${ids.join(", ")}`);
    assert.ok(ids.some((id) => /^@types\/node@[^/]+\/buffer(\.buffer)?\.d\.ts$/.test(id)), `${compiler}: ${ids.join(", ")}`);
    assert.ok(ids.every((id) => !id.startsWith("typescript")), "the default library is the compiler's boundary");

    // Project globals are visible even without a vocabulary allowlist, and become review material.
    writeFile(root, "src/globals.d.ts", "declare global { interface ProjectThing { x: number } }\nexport {};\n");
    writeFile(root, "node_modules/brand-kit/index.d.ts", "export type Brand = { readonly tag: string; thing?: ProjectThing };\n");
    writeFile(root, "tsconfig.json", JSON.stringify({ compilerOptions: options, include: ["src/**/*.ts"] }));
    const augmented = checkDesigns(root);
    assert.deepEqual(augmented.errors, [], compiler);
    assert.ok(augmented.index.packages[0].files.some(file => file.id === "project/src/globals.d.ts"));
    // And a reference that brings the project file in reaches a file outside every package.
    writeFile(root, "node_modules/brand-kit/index.d.ts", '/// <reference path="../../src/globals.d.ts" />\nexport type Brand = { readonly tag: string; thing?: ProjectThing };\n');
    const local = checkDesigns(root).errors;
    assert.equal(local.length, 1, compiler);
    assert.match(local[0].message, /its declarations reach src\/globals\.d\.ts is not inside an installed package/);
    assert.equal(executed(root), false, compiler);
  }
});

/** @tests Cli
 * @covers package-types */
test("a lock holds the declarations of the packages a locked declaration uses", (t) => {
  const design = mdx(lines('import type { Schema } from "schema-kit";', "", PARSER, "", data("Payload", "Schema<string>").replace("@data", "@data\n * @final"), "", data("Plain", "string").replace("@data", "@data\n * @final")));
  const root = project(t, "typescript-5", {}, design);
  assert.equal(cli(root, "lock").code, 0);
  const locks = JSON.parse(readFile(root, ".cage/lock.json")).locks as { name: string; members: Record<string, string> }[];
  const payload = locks.find((entry) => entry.name === "Payload")!;
  assert.deepEqual(Object.keys(payload.members), [":type", ":package schema-kit"]);
  assert.match(payload.members[":package schema-kit"], /^sha256:types-v2:[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(locks.find((entry) => entry.name === "Plain")!.members), [":type"]);
  const violations = (root: string) => check(root).report.diagnostics.filter((diagnostic) => diagnostic.code.startsWith("E_LOCK"));

  // The same declarations under TypeScript 6, in another layout and version, keep the lock.
  fs.unlinkSync(path.join(root, "node_modules/typescript"));
  fs.symlinkSync(path.resolve(import.meta.dirname, "../node_modules/typescript"), path.join(root, "node_modules/typescript"), "dir");
  editFile(root, "node_modules/schema-kit/types.d.ts", (text) => text.replace("/** A parser of unknown input. */\n", "// Reformatted.\n").replace("  parse(input: unknown): T;", "  parse(\n    input: unknown\n  ): T;"));
  editFile(root, "node_modules/schema-kit/package.json", (text) => text.replace('"1.2.0"', '"1.3.0"'));
  assert.deepEqual(violations(root), []);

  // A change of the declarations, here in the transitive package, is a change of the locked type.
  editFile(root, "node_modules/brand-kit/index.d.ts", (text) => text.replace("readonly tag: string", "readonly tag?: string"));
  const [violation, ...rest] = violations(root);
  assert.deepEqual(rest, []);
  assert.equal(violation.code, "E_LOCK_VIOLATION");
  assert.match(violation.message, /^Data type "Payload" is `@final`\nthe declarations of package schema-kit it uses changed; it was: sha256:/);
  assert.equal(executed(root), false);
});

/** @tests Cli
 * @covers package-types */
test("an extendable contract may add a member of a package type; a change of the package's declarations is still a violation", (t) => {
  const locked = contract("Parser", "parse(input: unknown): string;", "@invariant text Parses text.", "@extendable");
  const root = project(t, "typescript", {}, mdx(lines('import type { Schema } from "schema-kit";', "", locked)));
  editFile(root, IMPLEMENTATION, (text) => text.replace("  schema: ", "  private schema: "));
  assert.equal(cli(root, "lock").code, 0);
  editFile(root, DESIGN, (text) => text.replace("parse(input: unknown): string;", "parse(input: unknown): string;\n  schema: Schema<string>;"));
  editFile(root, IMPLEMENTATION, (text) => text.replace("  private schema: ", "  schema: "));
  const codes = () => check(root).report.diagnostics.filter((diagnostic) => diagnostic.code.includes("LOCK")).map((diagnostic) => diagnostic.code);
  assert.deepEqual(codes(), ["W_LOCK_UNRECORDED"]);
  assert.equal(cli(root, "lock").code, 0);
  assert.deepEqual(codes(), []);
  editFile(root, "node_modules/schema-kit/types.d.ts", (text) => text.replace("parse(input: unknown): T;", "parse(input: unknown): T | undefined;"));
  assert.deepEqual(codes(), ["E_LOCK_VIOLATION"]);
});
