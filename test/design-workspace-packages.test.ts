import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { CheckReport } from "../src/check.ts";
import type { ReviewIndex, ReviewReport } from "../src/review.ts";
import { at, checkDesigns, checkLinking, cli, contract, data, designFile, editFile, located, mdx, PROJECT_OPTIONS, readFile, scratchDirectory, writeFile } from "./helpers.ts";

// A design in an app of a monorepo imports the built declarations of a sibling workspace package, installed as a
// node_modules link to `packages/<name>` (npm, Yarn and Bun hoist it to the workspace root, pnpm links it into the
// app and into the packages that depend on it). Its JavaScript must never run.

const lines = (...text: string[]) => `${text.join("\n")}\n`;
const COMPILERS = ["typescript-5", "typescript"] as const;
const APP = "apps/app";
const DESIGN = designFile("runner");
const IMPLEMENTATION = "src/runner/runner.ts";
const TESTS = "src/runner/runner.test.ts";
const CONTRACTS = "packages/automation-contracts";
const BASE = "packages/automation-base";
const EXECUTED = "executed.txt";

type Layout = "array" | "object" | "pnpm";

const tripwire = (name: string) => `require("node:fs").writeFileSync(${JSON.stringify(EXECUTED)}, ${JSON.stringify(name)});\nthrow new Error("${name} was executed");\n`;

const RUNNER = contract("Runner", "task: Task;\n  run(): string;", "@invariant runs Runs the task.");

/** Links `link` (relative to the workspace) to `target` (relative to the workspace), with a relative link as package managers make them. */
function link(workspace: string, target: string, at: string): void {
  fs.mkdirSync(path.dirname(path.join(workspace, at)), { recursive: true });
  fs.symlinkSync(path.relative(path.dirname(path.join(workspace, at)), path.join(workspace, target)), path.join(workspace, at), "dir");
}

/**
 * A monorepo with the app `apps/app` as the project, whose design imports `@flygen/automation-contracts`; that
 * package's declarations import `@flygen/automation-base`, another workspace package. Returns the workspace root.
 */
function monorepo(t: TestContext, compiler: (typeof COMPILERS)[number], layout: Layout = "array", files: Record<string, string> = {}): string {
  const workspace = scratchDirectory(t, "workspace");
  const patterns = ["apps/*", "packages/*"];
  const all: Record<string, string> = {
    "package.json": JSON.stringify({ name: "monorepo", private: true, ...(layout === "array" ? { workspaces: patterns } : layout === "object" ? { workspaces: { packages: patterns, nohoist: [] } } : {}) }),
    ...(layout === "pnpm" ? { "pnpm-workspace.yaml": lines("# The workspace.", "packages:", "  - 'apps/*'", '  - "packages/*" # libraries', "  - '!**/test/**'", "", "catalog:", "  zod: ^3") } : {}),
    // The package exports built declarations; its source sits beside them and is never read.
    [`${CONTRACTS}/package.json`]: JSON.stringify({
      name: "@flygen/automation-contracts",
      version: "1.0.0",
      exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
      dependencies: { "@flygen/automation-base": "workspace:*" },
    }),
    [`${CONTRACTS}/dist/index.js`]: tripwire("automation-contracts"),
    [`${CONTRACTS}/dist/index.d.ts`]: 'export * from "./task.js";\n',
    [`${CONTRACTS}/dist/task.d.ts`]: lines('import type { Step } from "@flygen/automation-base";', "/** A task of automation. */", "export interface Task {", "  name: string;", "  steps: Step[];", "}"),
    [`${CONTRACTS}/src/index.ts`]: 'export * from "./task.ts";\n',
    [`${CONTRACTS}/src/task.ts`]: "export interface Task { name: number }\n",
    [`${BASE}/package.json`]: JSON.stringify({ name: "@flygen/automation-base", version: "2.0.0", main: "dist/index.js", types: "dist/index.d.ts" }),
    [`${BASE}/dist/index.js`]: tripwire("automation-base"),
    [`${BASE}/dist/index.d.ts`]: "export type Step = { readonly label: string };\n",
    [`${APP}/package.json`]: JSON.stringify({ name: "app", version: "0.0.0", private: true, type: "module", dependencies: { "@flygen/automation-contracts": "workspace:*" } }),
    [`${APP}/tsconfig.json`]: JSON.stringify({ compilerOptions: PROJECT_OPTIONS }),
    [`${APP}/.cage/config.json`]: JSON.stringify({ version: 1, review: "require", coverage: "off" }),
    [`${APP}/${DESIGN}`]: mdx(`import type { Task } from "@flygen/automation-contracts";\n\n${RUNNER}`),
    [`${APP}/${IMPLEMENTATION}`]: lines(
      'import type { Task } from "@flygen/automation-contracts";',
      "",
      "/** @implements Runner */",
      "export class TaskRunner {",
      '  task: Task = { name: "build", steps: [{ label: "compile" }] };',
      "  run(): string {",
      "    return this.task.steps.map((step) => step.label).join();",
      "  }",
      "}",
    ),
    [`${APP}/${TESTS}`]: lines(
      'import assert from "node:assert/strict";',
      'import { describe, it } from "node:test";',
      'import { TaskRunner } from "./runner.ts";',
      "",
      "/** @tests Runner */",
      'describe("Runner", () => {',
      "  /** @covers runs */",
      '  it("runs the task", () => {',
      '    assert.equal(new TaskRunner().run(), "compile");',
      "  });",
      "});",
    ),
    ...files,
  };
  for (const [file, text] of Object.entries(all)) writeFile(workspace, file, text);
  if (layout === "pnpm") {
    // pnpm links a workspace dependency into the node_modules of the package that depends on it, nothing at the root.
    link(workspace, CONTRACTS, `${APP}/node_modules/@flygen/automation-contracts`);
    link(workspace, BASE, `${CONTRACTS}/node_modules/@flygen/automation-base`);
  } else {
    link(workspace, CONTRACTS, "node_modules/@flygen/automation-contracts");
    link(workspace, BASE, "node_modules/@flygen/automation-base");
    link(workspace, APP, "node_modules/app");
  }
  fs.mkdirSync(path.join(workspace, "node_modules"), { recursive: true });
  fs.symlinkSync(path.resolve(import.meta.dirname, "../node_modules", compiler), path.join(workspace, "node_modules/typescript"), "dir");
  return workspace;
}

const executed = (workspace: string) => [workspace, path.join(workspace, APP), process.cwd()].some((directory) => fs.existsSync(path.join(directory, EXECUTED)));

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

function staleBecause(root: string): string | undefined {
  const stale = check(root).report.diagnostics.find((diagnostic) => diagnostic.code === "E_REVIEW_STALE" && diagnostic.contract === "Runner");
  return stale && stale.message.split("\n").slice(1).map((line) => line.replace(/^- /, "")).join(", ");
}

const FILES = [
  ["@flygen/automation-base@2.0.0/dist/index.d.ts", `../../${BASE}/dist/index.d.ts`],
  ["@flygen/automation-contracts@1.0.0/dist/index.d.ts", `../../${CONTRACTS}/dist/index.d.ts`],
  ["@flygen/automation-contracts@1.0.0/dist/task.d.ts", `../../${CONTRACTS}/dist/task.d.ts`],
];

/** @tests Cli
 * @covers package-types */
test("a linked workspace package can depend on an npm alias installed inside that package", (t) => {
  for (const compiler of COMPILERS) {
    const workspace = monorepo(t, compiler, "pnpm");
    const root = path.join(workspace, APP);
    const alias = `${CONTRACTS}/node_modules/brand-alias`;
    editFile(workspace, `${CONTRACTS}/package.json`, (text) => {
      const manifest = JSON.parse(text);
      manifest.dependencies["brand-alias"] = "npm:actual-brand@1.0.0";
      return JSON.stringify(manifest);
    });
    writeFile(workspace, `${alias}/package.json`, JSON.stringify({ name: "actual-brand", version: "1.0.0", types: "index.d.ts", main: "index.js" }));
    writeFile(workspace, `${alias}/index.js`, tripwire("actual-brand"));
    writeFile(workspace, `${alias}/index.d.ts`, "export type Label = string;\n");
    editFile(workspace, `${CONTRACTS}/dist/task.d.ts`, (text) => `import type { Label } from "brand-alias";\n${text.replace("name: string", "name: Label")}`);
    const result = checkDesigns(root);
    assert.deepEqual(result.errors, [], compiler);
    assert.ok(result.index.packages[0].files.some((file) => file.id === "actual-brand@1.0.0/index.d.ts"), compiler);
    assert.deepEqual(checkLinking(root).errors, [], compiler);

    writeFile(workspace, `${alias}/index.d.ts`, "export type Label = number;\n");
    assert.ok(checkLinking(root).errors.length > 0, compiler);
    editFile(workspace, `${CONTRACTS}/package.json`, (text) => {
      const manifest = JSON.parse(text);
      delete manifest.dependencies["brand-alias"];
      return JSON.stringify(manifest);
    });
    const errors = checkDesigns(root).errors;
    assert.equal(errors.length, 1, compiler);
    assert.equal(errors[0].code, "E_DESIGN_IMPORT", compiler);
    assert.match(errors[0].message, /nothing that reaches it declares "brand-alias"/);
    assert.equal(executed(workspace), false, compiler);
  }
});

/** @tests Cli
 * @covers package-types */
test("an app imports the declarations of a linked workspace package and of the workspace packages they import, on TypeScript 5 and 6", (t) => {
  for (const compiler of COMPILERS) {
    for (const layout of ["array", "object", "pnpm"] as const) {
      const workspace = monorepo(t, compiler, layout);
      const root = path.join(workspace, APP);
      const result = checkDesigns(root);
      assert.equal(result.typescript.version.split(".")[0], compiler === "typescript-5" ? "5" : "6");
      assert.deepEqual(result.errors, [], `${compiler} ${layout}`);
      const [entry] = result.index.packages;
      assert.equal(result.index.packages.length, 1);
      assert.deepEqual(
        { specifier: entry.specifier, name: entry.name, version: entry.version, directory: entry.directory, names: entry.names, location: entry.location },
        { specifier: "@flygen/automation-contracts", name: "@flygen/automation-contracts", version: "1.0.0", directory: `../../${CONTRACTS}`, names: ["Task"], location: at(root, "runner", "import type") },
        `${compiler} ${layout}`,
      );
      // Named by package, version and path inside the package; the transitive workspace package is part of the closure.
      assert.deepEqual(entry.files.map((file) => [file.id, file.file]), FILES, `${compiler} ${layout}`);
      assert.deepEqual(entry.declarations.map(({ name, id, line }) => [name, id, line]), [["Task", "@flygen/automation-contracts@1.0.0/dist/task.d.ts", 3]]);

      // The declarations are the types, not the source beside them, and the transitive Step is no `any`.
      assert.deepEqual(checkLinking(root).errors, [], `${compiler} ${layout}`);
      editFile(workspace, `${BASE}/dist/index.d.ts`, (text) => text.replace("readonly label: string", "readonly label: number"));
      assert.ok(checkLinking(root).errors.length > 0, `${compiler} ${layout}`);
      assert.equal(executed(workspace), false, `${compiler} ${layout}`);
    }
  }
});

/** @tests Cli
 * @covers package-types */
test("in a workspace, links to elsewhere, path aliases, uninstalled or misnamed packages, sources and declarations that escape are not imported", (t) => {
  for (const compiler of COMPILERS) {
    const elsewhere = scratchDirectory(t, "outside-workspace");
    writeFile(elsewhere, "kit/package.json", JSON.stringify({ name: "outside-kit", version: "1.0.0", types: "index.d.ts" }));
    writeFile(elsewhere, "kit/index.d.ts", "export type Secret = string;\n");
    const workspace = monorepo(t, compiler, "array", {
      // A directory of the workspace that its patterns do not name.
      "tools/kit/package.json": JSON.stringify({ name: "tools-kit", version: "1.0.0", types: "index.d.ts" }),
      "tools/kit/index.d.ts": "export type Secret = string;\n",
      "shared/secret.d.ts": "export type Secret = string;\n",
      // A workspace package nothing installs.
      "packages/unlinked/package.json": JSON.stringify({ name: "@flygen/unlinked", version: "1.0.0", types: "dist/index.d.ts" }),
      "packages/unlinked/dist/index.d.ts": "export type Secret = string;\n",
      // Installed, but its declarations reach a package nothing installs, a file of no package, the project, or source.
      "packages/reaches-unlinked/package.json": JSON.stringify({ name: "@flygen/reaches-unlinked", version: "1.0.0", types: "dist/index.d.ts" }),
      "packages/reaches-unlinked/dist/index.d.ts": 'export type { Secret } from "../../unlinked/dist/index.js";\n',
      "packages/escapes/package.json": JSON.stringify({ name: "@flygen/escapes", version: "1.0.0", types: "dist/index.d.ts" }),
      "packages/escapes/dist/index.d.ts": 'export type { Secret } from "../../../shared/secret.js";\n',
      "packages/reaches-app/package.json": JSON.stringify({ name: "@flygen/reaches-app", version: "1.0.0", types: "dist/index.d.ts" }),
      "packages/reaches-app/dist/index.d.ts": `export type { Secret } from "../../../${APP}/types/secret.js";\n`,
      [`${APP}/types/secret.d.ts`]: "export type Secret = string;\n",
      "packages/leaky/package.json": JSON.stringify({ name: "@flygen/leaky", version: "1.0.0", types: "dist/index.d.ts" }),
      "packages/leaky/dist/index.d.ts": 'export type { Secret } from "../src/index.ts";\n',
      "packages/leaky/src/index.ts": "export type Secret = string;\n",
      // A package that exports its TypeScript source.
      "packages/source/package.json": JSON.stringify({ name: "@flygen/source", version: "1.0.0", exports: { ".": "./src/index.ts" } }),
      "packages/source/src/index.ts": "export type Secret = string;\n",
      // A link whose name is not the name of the package it leads to.
      "packages/renamed/package.json": JSON.stringify({ name: "@flygen/other-name", version: "1.0.0", types: "index.d.ts" }),
      "packages/renamed/index.d.ts": "export type Secret = string;\n",
      [`${APP}/tsconfig.json`]: JSON.stringify({
        compilerOptions: {
          ...PROJECT_OPTIONS,
          paths: { "alias-kit": [`../../${CONTRACTS}/dist/index.d.ts`], "unlinked-kit": ["../../packages/unlinked/dist/index.d.ts"], "app-kit": ["./types/secret.d.ts"] },
        },
      }),
    });
    const root = path.join(workspace, APP);
    fs.symlinkSync(path.join(elsewhere, "kit"), path.join(workspace, "node_modules/outside-kit"), "dir");
    for (const name of ["reaches-unlinked", "escapes", "reaches-app", "leaky", "source", "renamed"]) link(workspace, `packages/${name}`, `node_modules/@flygen/${name}`);
    link(workspace, "packages/renamed", "node_modules/@flygen/other-name");
    link(workspace, "tools/kit", "node_modules/tools-kit");
    const specifiers = ["outside-kit", "tools-kit", "alias-kit", "unlinked-kit", "app-kit", "@flygen/unlinked", "@flygen/reaches-unlinked", "@flygen/escapes", "@flygen/reaches-app", "@flygen/leaky", "@flygen/source", "@flygen/renamed"];
    editFile(root, DESIGN, (text) => text.replace('import type { Task } from "@flygen/automation-contracts";', [
      'import type { Task } from "@flygen/automation-contracts";',
      ...specifiers.map((specifier, i) => `import type { Secret as S${i} } from "${specifier}";`),
    ].join("\n")));
    const errors = checkDesigns(root).errors;
    assert.deepEqual(errors.map(located), specifiers.map((specifier) => ({ code: "E_DESIGN_IMPORT", ...at(root, "runner", `"${specifier}"`) })), compiler);
    const message = (specifier: string) => errors.find((diagnostic) => diagnostic.message.startsWith(`"${specifier}"`))!.message;
    assert.match(message("outside-kit"), /not to an installed package; a path alias/);
    assert.match(message("tools-kit"), /resolves to \.\.\/\.\.\/tools\/kit\/index\.d\.ts, not to an installed package/);
    assert.match(message("alias-kit"), /resolves to \.\.\/\.\.\/packages\/automation-contracts\/dist\/index\.d\.ts, not to an installed package/);
    assert.match(message("unlinked-kit"), /not to an installed package \(\.\.\/\.\.\/packages\/unlinked is the workspace package @flygen\/unlinked, but no node_modules .* links to it\)/);
    assert.match(message("app-kit"), /resolves to types\/secret\.d\.ts, not to an installed package; a path alias/);
    assert.match(message("@flygen/unlinked"), /resolves to no installed package's types/);
    assert.match(message("@flygen/reaches-unlinked"), /its declarations reach \.\.\/\.\.\/packages\/unlinked is the workspace package @flygen\/unlinked, but no node_modules/);
    assert.match(message("@flygen/escapes"), /its declarations reach \.\.\/\.\.\/shared\/secret\.d\.ts is not inside an installed package/);
    assert.match(message("@flygen/reaches-app"), /its declarations reach types\/secret\.d\.ts is not inside an installed package/);
    assert.match(message("@flygen/leaky"), /its declarations reach @flygen\/leaky@1\.0\.0\/src\/index\.ts, which is not a declaration file/);
    assert.match(message("@flygen/source"), /@flygen\/source@1\.0\.0\/src\/index\.ts, which is not a declaration file/);
    assert.match(message("@flygen/renamed"), /resolves into the package @flygen\/other-name, not @flygen\/renamed/);
    assert.equal(executed(workspace), false, compiler);
  }
});

/** @tests Cli
 * @covers package-types */
test("a workspace whose patterns do not take in the project, or a package.json without workspaces, makes no link a package", (t) => {
  for (const manifest of [{ name: "monorepo", private: true, workspaces: ["packages/*"] }, { name: "monorepo", private: true }, { name: "monorepo", workspaces: "packages/*" }]) {
    const workspace = monorepo(t, "typescript", "array", { "package.json": JSON.stringify(manifest) });
    const errors = checkDesigns(path.join(workspace, APP)).errors;
    assert.deepEqual(errors.map(located), [{ code: "E_DESIGN_IMPORT", ...at(path.join(workspace, APP), "runner", '"@flygen/automation-contracts"') }], JSON.stringify(manifest));
    assert.match(errors[0].message, /resolves to \.\.\/\.\.\/packages\/automation-contracts\/dist\/index\.d\.ts, not to an installed package/);
  }
  // pnpm patterns that exclude the package.
  const workspace = monorepo(t, "typescript", "pnpm", { "pnpm-workspace.yaml": lines("packages: ['apps/*', 'packages/*', '!packages/automation-base']") });
  const errors = checkDesigns(path.join(workspace, APP)).errors;
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /its declarations reach \.\.\/\.\.\/packages\/automation-base\/dist\/index\.d\.ts is not inside an installed package/);
});

/** @tests Cli
 * @covers package-types */
test("the declarations of linked workspace packages are review material and lock the types that use them, wherever the workspace lies", (t) => {
  for (const compiler of COMPILERS) {
    const design = mdx(lines('import type { Task } from "@flygen/automation-contracts";', "", RUNNER, "", data("Payload", "Task").replace("@data", "@data\n * @final")));
    const workspace = monorepo(t, compiler, "array", { [`${APP}/${DESIGN}`]: design });
    const root = path.join(workspace, APP);
    const packet = packets(root);
    const runner = packet.contracts.find((entry) => entry.contract === "Runner")!;
    assert.deepEqual(runner.packages, [{ name: "@flygen/automation-contracts", versions: ["1.0.0"], directory: `../../${CONTRACTS}` }]);
    const packageFiles = Object.fromEntries(packet.files.filter((file) => file.role === "package").map((file) => [file.path, file.text]));
    assert.deepEqual(Object.keys(packageFiles).sort(), [`../../${CONTRACTS}`, ...FILES.map(([, file]) => file)].sort());
    for (const [, file] of FILES) assert.equal(packageFiles[file], readFile(root, file), file);
    assert.match(packageFiles[`../../${CONTRACTS}`], /^package @flygen\/automation-contracts@1\.0\.0: types only, never executed\n/);
    assert.equal(cli(root, "lock").code, 0);
    recordAdequate(root);
    const lock = (JSON.parse(readFile(root, ".cage/lock.json")).locks as { name: string; members: Record<string, string> }[]).find((entry) => entry.name === "Payload")!;
    assert.deepEqual(Object.keys(lock.members), [":type", ":package @flygen/automation-contracts"]);
    const locks = (root: string) => check(root).report.diagnostics.filter((diagnostic) => diagnostic.code.startsWith("E_LOCK"));

    // The same workspace elsewhere, with relative links: the material and the lock are the same.
    const moved = path.join(scratchDirectory(t, "moved"), "monorepo");
    fs.cpSync(workspace, moved, { recursive: true, verbatimSymlinks: true });
    assert.equal(staleBecause(path.join(moved, APP)), undefined, compiler);
    assert.deepEqual(locks(path.join(moved, APP)), [], compiler);

    // Comments and layout are not types; a change of the transitive package's declarations is a change of the material and of the lock.
    editFile(workspace, `${BASE}/dist/index.d.ts`, (text) => `/** Steps. */\n${text}`);
    assert.equal(staleBecause(root), undefined, compiler);
    assert.deepEqual(locks(root), [], compiler);
    editFile(workspace, `${BASE}/dist/index.d.ts`, (text) => text.replace("readonly label: string", "readonly label?: string"));
    assert.equal(staleBecause(root), "declaration file @flygen/automation-base@2.0.0/dist/index.d.ts changed", compiler);
    const [violation, ...rest] = locks(root);
    assert.deepEqual(rest, [], compiler);
    assert.equal(violation.code, "E_LOCK_VIOLATION");
    assert.match(violation.message, /the declarations of package @flygen\/automation-contracts it uses changed/);

    // A new version of the workspace package is other review material.
    editFile(workspace, `${BASE}/dist/index.d.ts`, (text) => text.replace("readonly label?: string", "readonly label: string"));
    editFile(workspace, `${CONTRACTS}/package.json`, (text) => text.replace('"1.0.0"', '"1.1.0"'));
    assert.match(staleBecause(root) ?? "", /the types of package @flygen\/automation-contracts changed/, compiler);
    assert.deepEqual(locks(root), [], compiler);
    assert.equal(executed(workspace), false, compiler);
  }
});

/** @tests Cli
 * @covers package-types */
test("whether a pnpm workspace package is installed does not depend on the order in which its declarations are reached", (t) => {
  const MIDDLE = "packages/automation-middle";
  const GLOBALS = "packages/automation-globals";
  for (const compiler of COMPILERS) {
    const workspace = monorepo(t, compiler, "pnpm", {
      // The names come before the import: the checker leads from `Step` straight to base and from `Env` to the global,
      // both before the file of middle that links them is reached.
      [`${CONTRACTS}/dist/task.d.ts`]: lines("/** A task of automation. */", "export interface Task {", "  name: string;", "  steps: Step[];", "  env: Env;", "}", 'import type { Step } from "@flygen/automation-middle";'),
      [`${MIDDLE}/package.json`]: JSON.stringify({ name: "@flygen/automation-middle", version: "3.0.0", types: "dist/index.d.ts" }),
      [`${MIDDLE}/dist/index.d.ts`]: lines('/// <reference types="@flygen/automation-globals" />', 'export type { Step } from "@flygen/automation-base";'),
      [`${GLOBALS}/package.json`]: JSON.stringify({ name: "@flygen/automation-globals", version: "4.0.0", types: "dist/index.d.ts" }),
      [`${GLOBALS}/dist/index.d.ts`]: "interface Env { readonly mode: string }\n",
      [`${APP}/${IMPLEMENTATION}`]: lines(
        'import type { Task } from "@flygen/automation-contracts";',
        "",
        "/** @implements Runner */",
        "export class TaskRunner {",
        '  task: Task = { name: "build", steps: [{ label: "compile" }], env: { mode: "ci" } };',
        "  run(): string {",
        "    return this.task.steps.map((step) => step.label).join();",
        "  }",
        "}",
      ),
    });
    // Each link only in the node_modules of the package that imports it: app -> contracts -> middle -> base and globals.
    fs.unlinkSync(path.join(workspace, `${CONTRACTS}/node_modules/@flygen/automation-base`));
    link(workspace, MIDDLE, `${CONTRACTS}/node_modules/@flygen/automation-middle`);
    link(workspace, BASE, `${MIDDLE}/node_modules/@flygen/automation-base`);
    link(workspace, GLOBALS, `${MIDDLE}/node_modules/@flygen/automation-globals`);
    const root = path.join(workspace, APP);
    const result = checkDesigns(root);
    assert.deepEqual(result.errors, [], compiler);
    assert.deepEqual(result.index.packages[0].files.map((file) => file.id), [
      "@flygen/automation-base@2.0.0/dist/index.d.ts",
      "@flygen/automation-contracts@1.0.0/dist/index.d.ts",
      "@flygen/automation-contracts@1.0.0/dist/task.d.ts",
      "@flygen/automation-globals@4.0.0/dist/index.d.ts",
      "@flygen/automation-middle@3.0.0/dist/index.d.ts",
    ], compiler);
    assert.deepEqual(checkLinking(root).errors, [], compiler);
    editFile(workspace, `${GLOBALS}/dist/index.d.ts`, (text) => text.replace("mode: string", "mode: number"));
    assert.ok(checkLinking(root).errors.length > 0, compiler);

    // Without the link from middle, base is reached all the same and is no installed package, whatever came first.
    fs.unlinkSync(path.join(workspace, `${MIDDLE}/node_modules/@flygen/automation-base`));
    writeFile(workspace, `${MIDDLE}/dist/index.d.ts`, lines('/// <reference types="@flygen/automation-globals" />', 'export type { Step } from "../../automation-base/dist/index.js";'));
    const errors = checkDesigns(root).errors;
    assert.equal(errors.length, 1, compiler);
    assert.match(errors[0].message, /its declarations reach \.\.\/\.\.\/packages\/automation-base is the workspace package @flygen\/automation-base, but no node_modules/, compiler);
    assert.equal(executed(workspace), false, compiler);
  }
});
