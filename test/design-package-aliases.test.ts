import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { CheckReport } from "../src/check.ts";
import type { ReviewIndex, ReviewReport } from "../src/review.ts";
import { at, checkDesigns, checkLinking, cli, contract, data, designFile, designProject, editFile, located, mdx, readFile, writeFile } from "./helpers.ts";

// An npm alias installs a package under another name: `"playwright": "npm:rebrowser-playwright@1.52.0"` puts the
// package rebrowser-playwright in node_modules/playwright. A design may import its types by the alias when the
// project declares it; the package is known by its own name and version. Its JavaScript must never run.

const lines = (...text: string[]) => `${text.join("\n")}\n`;
const COMPILERS = ["typescript-5", "typescript"] as const;
const DESIGN = designFile("browser");
const IMPLEMENTATION = "src/browser/browser.ts";
const TESTS = "src/browser/browser.test.ts";
const EXECUTED = "executed.txt";

const tripwire = (name: string) => `require("node:fs").writeFileSync(${JSON.stringify(EXECUTED)}, ${JSON.stringify(name)});\nthrow new Error("${name} was executed");\n`;

const ALIASES = { playwright: "npm:rebrowser-playwright@1.52.0", kit: "npm:@scope/real-kit@^2.0.0", "@alias/kit": "npm:@scope/real-kit@^2.0.0" };

/** The packages as npm installs them: each alias is a directory named by the alias, holding the package it names. */
function npmLayout(): Record<string, string> {
  return {
    "node_modules/playwright/package.json": JSON.stringify({
      name: "rebrowser-playwright",
      version: "1.52.0",
      exports: { ".": { types: "./index.d.ts", default: "./index.js" }, "./test": { types: "./test.d.ts", default: "./test.js" } },
      // The package itself depends on an aliased package: a transitive alias.
      dependencies: { "playwright-core": "npm:rebrowser-playwright-core@1.52.0" },
      scripts: { postinstall: "node index.js" },
    }),
    "node_modules/playwright/index.js": tripwire("rebrowser-playwright"),
    "node_modules/playwright/test.js": tripwire("rebrowser-playwright/test"),
    "node_modules/playwright/index.d.ts": 'export type { Page } from "playwright-core";\n',
    "node_modules/playwright/test.d.ts": lines('import type { Page } from "playwright-core";', "export interface Fixtures { page: Page }"),
    "node_modules/playwright-core/package.json": JSON.stringify({ name: "rebrowser-playwright-core", version: "1.52.0", types: "index.d.ts", main: "index.js" }),
    "node_modules/playwright-core/index.js": tripwire("rebrowser-playwright-core"),
    "node_modules/playwright-core/index.d.ts": lines("export interface Page {", "  goto(url: string): Promise<void>;", "  title(): Promise<string>;", "}"),
    // A scoped target under a plain and under a scoped alias.
    "node_modules/kit/package.json": JSON.stringify({ name: "@scope/real-kit", version: "2.1.0", types: "index.d.ts" }),
    "node_modules/kit/index.d.ts": "export type Tag = { readonly tag: string };\n",
    "node_modules/@alias/kit/package.json": JSON.stringify({ name: "@scope/real-kit", version: "2.1.0", types: "index.d.ts" }),
    "node_modules/@alias/kit/index.d.ts": "export type Tag = { readonly tag: string };\n",
  };
}

const BROWSER = contract("Browser", "page: Page;\n  open(url: string): Promise<string>;", "@invariant opens Opens a page and reads its title.");
const IMPORTS = 'import type { Page } from "playwright";';

function project(t: TestContext, compiler: (typeof COMPILERS)[number], files: Record<string, string>, design = mdx(lines(IMPORTS, "", BROWSER))): string {
  const root = designProject(t, { browser: design }, {
    "package.json": JSON.stringify({ private: true, type: "module", devDependencies: ALIASES }),
    [IMPLEMENTATION]: lines(
      'import type { Page } from "playwright";',
      "",
      "/** @implements Browser */",
      "export class RealBrowser {",
      "  constructor(public page: Page) {}",
      "  async open(url: string): Promise<string> {",
      "    await this.page.goto(url);",
      "    return this.page.title();",
      "  }",
      "}",
    ),
    [TESTS]: lines(
      'import assert from "node:assert/strict";',
      'import { it } from "node:test";',
      'import { RealBrowser } from "./browser.ts";',
      "",
      "/** @tests Browser",
      " * @covers opens */",
      'it("opens a page", async () => {',
      '  const browser = new RealBrowser({ goto: async () => {}, title: async () => "T" });',
      '  assert.equal(await browser.open("x"), "T");',
      "});",
    ),
    ".cage/config.json": JSON.stringify({ version: 1, review: "require", coverage: "off" }),
    ...files,
  });
  fs.symlinkSync(path.resolve(import.meta.dirname, "../node_modules", compiler), path.join(root, "node_modules/typescript"), "dir");
  return root;
}

const executed = (root: string) => fs.existsSync(path.join(root, EXECUTED)) || fs.existsSync(path.join(process.cwd(), EXECUTED));

function check(root: string): CheckReport {
  return JSON.parse(cli(root, "check", "--format", "json").stdout) as CheckReport;
}

function recordAdequate(root: string): void {
  const index = JSON.parse(cli(root, "review", "--all", "--format", "json").stdout) as ReviewIndex;
  const report = JSON.parse(cli(root, "review", ...index.contracts.map((entry) => entry.contract), "--format", "json").stdout) as ReviewReport;
  const verdicts = report.contracts.map(({ contract: name, fingerprint, invariants }) => ({
    contract: name,
    fingerprint,
    findings: invariants.map(({ id }) => ({ invariant: id, assessment: "adequate", reason: "Checked.", evidence: `${TESTS}:7`, suggestedChange: null })),
  }));
  writeFile(root, "verdicts.json", JSON.stringify({ version: 1, verdicts }));
  assert.equal(cli(root, "review", "--record", "verdicts.json").code, 0);
  const errors = check(root).diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  assert.deepEqual(errors.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`), []);
}

const staleBecause = (root: string) => {
  const stale = check(root).diagnostics.find((diagnostic) => diagnostic.code === "E_REVIEW_STALE");
  return stale && stale.message.split("\n").slice(1).map((line) => line.replace(/^- /, "")).join(", ");
};

/** @tests Cli
 * @covers package-types */
test("a declared npm alias is imported by its alias, with subpaths, scoped targets and an aliased transitive package, on TypeScript 5 and 6", (t) => {
  for (const compiler of COMPILERS) {
    const design = mdx(lines(
      IMPORTS,
      'import type { Fixtures } from "playwright/test";',
      'import type { Tag } from "kit";',
      'import type { Tag as Scoped } from "@alias/kit";',
      "",
      BROWSER,
      "",
      data("Labels", "[Tag, Scoped, Fixtures]"),
    ));
    const root = project(t, compiler, npmLayout(), design);
    const result = checkDesigns(root);
    assert.equal(result.typescript.version.split(".")[0], compiler === "typescript-5" ? "5" : "6");
    assert.deepEqual(result.errors, [], compiler);
    const packages = result.index.packages.map(({ specifier, name, version, directory, names, files }) => ({ specifier, name, version, directory, names, files: files.map((file) => [file.id, file.file]) }));
    const core = ["rebrowser-playwright-core@1.52.0/index.d.ts", "node_modules/playwright-core/index.d.ts"];
    // Known by the package's own name and version, wherever the alias installed it.
    assert.deepEqual(packages, [
      { specifier: "playwright", name: "rebrowser-playwright", version: "1.52.0", directory: "node_modules/playwright", names: ["Page"], files: [core, ["rebrowser-playwright@1.52.0/index.d.ts", "node_modules/playwright/index.d.ts"]] },
      { specifier: "playwright/test", name: "rebrowser-playwright", version: "1.52.0", directory: "node_modules/playwright", names: ["Fixtures"], files: [core, ["rebrowser-playwright@1.52.0/test.d.ts", "node_modules/playwright/test.d.ts"]] },
      { specifier: "kit", name: "@scope/real-kit", version: "2.1.0", directory: "node_modules/kit", names: ["Tag"], files: [["@scope/real-kit@2.1.0/index.d.ts", "node_modules/kit/index.d.ts"]] },
      // TypeScript shares the package-id binding with `kit`, so both the resolved root and the bound declaration matter.
      { specifier: "@alias/kit", name: "@scope/real-kit", version: "2.1.0", directory: "node_modules/@alias/kit", names: ["Tag"], files: [["@scope/real-kit@2.1.0/index.d.ts", "node_modules/@alias/kit/index.d.ts"], ["@scope/real-kit@2.1.0/index.d.ts", "node_modules/kit/index.d.ts"]] },
    ], compiler);
    assert.deepEqual(result.index.packages[0].declarations.map(({ name, id, line }) => [name, id, line]), [["Page", "rebrowser-playwright-core@1.52.0/index.d.ts", 1]]);

    // The types are compared like any other: they are not `any`.
    assert.deepEqual(checkLinking(root).errors, [], compiler);
    editFile(root, "node_modules/playwright-core/index.d.ts", (text) => text.replace("title(): Promise<string>;", "title(): Promise<number>;"));
    assert.ok(checkLinking(root).errors.length > 0, compiler);
    assert.equal(executed(root), false, compiler);
  }
});

/** @tests Cli
 * @covers package-types */
test("an alias installed by pnpm, through links into its store, is imported by its alias", (t) => {
  for (const compiler of COMPILERS) {
    const store = "node_modules/.pnpm";
    const target = `${store}/rebrowser-playwright@1.52.0/node_modules/rebrowser-playwright`;
    const core = `${store}/rebrowser-playwright-core@1.52.0/node_modules/rebrowser-playwright-core`;
    const root = project(t, compiler, {
      [`${target}/package.json`]: JSON.stringify({ name: "rebrowser-playwright", version: "1.52.0", types: "index.d.ts", dependencies: { "playwright-core": "npm:rebrowser-playwright-core@1.52.0" } }),
      [`${target}/index.d.ts`]: 'export type { Page } from "playwright-core";\n',
      [`${core}/package.json`]: JSON.stringify({ name: "rebrowser-playwright-core", version: "1.52.0", types: "index.d.ts" }),
      [`${core}/index.d.ts`]: "export interface Page { goto(url: string): Promise<void>; title(): Promise<string> }\n",
    });
    fs.symlinkSync(path.join(root, target), path.join(root, "node_modules/playwright"), "dir");
    fs.symlinkSync(path.join(root, core), path.join(root, `${store}/rebrowser-playwright@1.52.0/node_modules/playwright-core`), "dir");
    const result = checkDesigns(root);
    assert.deepEqual(result.errors, [], compiler);
    const [entry] = result.index.packages;
    assert.deepEqual([entry.name, entry.version, entry.directory, entry.files.map((file) => file.id)], ["rebrowser-playwright", "1.52.0", target, ["rebrowser-playwright-core@1.52.0/index.d.ts", "rebrowser-playwright@1.52.0/index.d.ts"]], compiler);

    // Without the declaration the link is a package under another name, as before.
    writeFile(root, "package.json", JSON.stringify({ private: true, type: "module" }));
    const errors = checkDesigns(root).errors;
    assert.deepEqual(errors.map(located), [{ code: "E_DESIGN_IMPORT", ...at(root, "browser", '"playwright"') }], compiler);
    assert.match(errors[0].message, /resolves into the package rebrowser-playwright, not playwright/);
  }
});

/** @tests Cli
 * @covers package-types */
test("an undeclared, mistargeted or disguised alias is not a package, and an aliased package is held to the rules of every package", (t) => {
  for (const compiler of COMPILERS) {
    const root = project(t, compiler, {
      ...npmLayout(),
      // A path alias to project source, and one to the aliased package under a name nothing installs.
      "src/fake/playwright.d.ts": "export interface Page { goto(url: string): Promise<void> }\n",
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, allowImportingTsExtensions: true,
          paths: { "fake-playwright": ["./src/fake/playwright.d.ts"], pw: ["./node_modules/playwright/index.d.ts"] },
        },
      }),
      "package.json": JSON.stringify({
        private: true,
        type: "module",
        devDependencies: { ...ALIASES, "fake-playwright": "npm:rebrowser-playwright@1.52.0", pw: "npm:rebrowser-playwright@1.52.0", "other-kit": "npm:@scope/real-kit@^2.0.0", source: "npm:source-only@1.0.0", broken: "npm:broken-kit@1.0.0" },
      }),
      // Installed under a name the project does not declare; declared, but installed with another package.
      "node_modules/undeclared/package.json": JSON.stringify({ name: "rebrowser-playwright", version: "1.52.0", types: "index.d.ts" }),
      "node_modules/undeclared/index.d.ts": "export interface Page { goto(url: string): Promise<void> }\n",
      "node_modules/other-kit/package.json": JSON.stringify({ name: "@scope/impostor-kit", version: "2.1.0", types: "index.d.ts" }),
      "node_modules/other-kit/index.d.ts": "export type Tag = { readonly tag: string };\n",
      // Declared aliases to a package without declarations and to one whose declarations lead nowhere.
      "node_modules/source/package.json": JSON.stringify({ name: "source-only", version: "1.0.0", exports: { ".": "./index.ts" } }),
      "node_modules/source/index.ts": "export interface Page { goto(url: string): Promise<void> }\n",
      "node_modules/broken/package.json": JSON.stringify({ name: "broken-kit", version: "1.0.0", types: "index.d.ts" }),
      "node_modules/broken/index.d.ts": 'export type { Page } from "./missing.js";\n',
    });
    const specifiers = ["fake-playwright", "pw", "undeclared", "other-kit", "source", "broken"];
    editFile(root, DESIGN, (text) => text.replace(IMPORTS, [IMPORTS, ...specifiers.map((specifier, i) => `import type { Page as P${i} } from "${specifier}";`)].join("\n")));
    const errors = checkDesigns(root).errors;
    assert.deepEqual(errors.map(located), specifiers.map((specifier) => ({ code: "E_DESIGN_IMPORT", ...at(root, "browser", `"${specifier}"`) })), compiler);
    const message = (specifier: string) => errors.find((diagnostic) => diagnostic.message.startsWith(`"${specifier}"`))!.message;
    assert.match(message("fake-playwright"), /resolves to src\/fake\/playwright\.d\.ts, not to an installed package; a path alias/);
    // A declaration does not make a path alias a package: node_modules/pw is not where it leads.
    assert.match(message("pw"), /resolves into node_modules\/playwright, whose package\.json does not name the package playwright but rebrowser-playwright/);
    assert.match(message("undeclared"), /package\.json does not name the package undeclared but rebrowser-playwright, and the project declares no "undeclared": "npm:rebrowser-playwright@…"/);
    assert.match(message("other-kit"), /package\.json does not name the package other-kit but @scope\/impostor-kit/);
    assert.match(message("source"), /source-only@1\.0\.0\/index\.ts, which is not a declaration file/);
    assert.match(message("broken"), /node_modules\/broken\/index\.d\.ts:1:\d+ TS2307 Cannot find module '\.\/missing\.js'/);
    assert.equal(executed(root), false, compiler);
  }
});

/** @tests Cli
 * @covers package-types */
test("an aliased package reached from another package must be declared by what reaches it", (t) => {
  const root = project(t, "typescript", npmLayout());
  assert.deepEqual(checkDesigns(root).errors, []);
  const blocked = () => {
    const errors = checkDesigns(root).errors;
    assert.deepEqual(errors.map(located), [{ code: "E_DESIGN_IMPORT", ...at(root, "browser", '"playwright"') }]);
    return errors[0].message;
  };
  const expected = /^"playwright" is not supported: its declarations reach node_modules\/playwright-core, whose package\.json does not name the package playwright-core but rebrowser-playwright-core, and nothing that reaches it declares "playwright-core": "npm:rebrowser-playwright-core@…"/;

  // Not declared by the package that imports it.
  editFile(root, "node_modules/playwright/package.json", (text) => text.replace('"dependencies"', '"unrelated"'));
  assert.match(blocked(), expected);
  // A development dependency of an installed package is not installed for it.
  editFile(root, "node_modules/playwright/package.json", (text) => text.replace('"unrelated"', '"devDependencies"'));
  assert.match(blocked(), expected);
  // An optional or peer dependency is.
  editFile(root, "node_modules/playwright/package.json", (text) => text.replace('"devDependencies"', '"peerDependencies"'));
  assert.deepEqual(checkDesigns(root).errors, []);
  // Declared as an alias of another package.
  editFile(root, "node_modules/playwright/package.json", (text) => text.replace("npm:rebrowser-playwright-core@1.52.0", "npm:patchright-core@1.52.0"));
  assert.match(blocked(), expected);
  assert.equal(executed(root), false);
});

/** @tests Cli
 * @covers package-types */
test("an alias that leads to another package makes the review stale and breaks a lock; its new version stales the review only", (t) => {
  const design = mdx(lines(IMPORTS, "", BROWSER, "", data("Snapshot", "Page").replace("@data", "@data\n * @final")));
  const root = project(t, "typescript", npmLayout(), design);
  const packets = JSON.parse(cli(root, "review", "Browser", "--format", "json").stdout) as ReviewReport;
  assert.deepEqual(packets.contracts[0].packages, [{ name: "rebrowser-playwright", versions: ["1.52.0"], directory: "node_modules/playwright" }]);
  assert.equal(cli(root, "lock").code, 0);
  const locks = JSON.parse(readFile(root, ".cage/lock.json")).locks as { name: string; members: Record<string, string> }[];
  assert.deepEqual(Object.keys(locks.find((entry) => entry.name === "Snapshot")!.members), [":type", ":package rebrowser-playwright"]);
  recordAdequate(root);
  const lockErrors = () => check(root).diagnostics.filter((diagnostic) => diagnostic.code.startsWith("E_LOCK"));

  // A new version of the same target: other review material, the same locked declarations.
  editFile(root, "node_modules/playwright/package.json", (text) => text.replace('"version":"1.52.0"', '"version":"1.52.1"'));
  assert.match(staleBecause(root) ?? "", /the types of package rebrowser-playwright/);
  assert.deepEqual(lockErrors(), []);
  recordAdequate(root);

  // The alias retargeted to another package with the very same declarations: another package's types.
  editFile(root, "package.json", (text) => text.replace("npm:rebrowser-playwright@1.52.0", "npm:patchright@1.52.0"));
  editFile(root, "node_modules/playwright/package.json", (text) => text.replace('"name":"rebrowser-playwright"', '"name":"patchright"'));
  assert.equal(staleBecause(root), "the types of package patchright is new, declaration file patchright@1.52.1/index.d.ts is new, the types of package rebrowser-playwright is gone, declaration file rebrowser-playwright@1.52.1/index.d.ts is gone");
  const [violation, ...rest] = lockErrors();
  assert.deepEqual(rest, []);
  assert.equal(violation.code, "E_LOCK_VIOLATION");
  assert.match(violation.message, /the declarations of package rebrowser-playwright it uses was removed; .*\nthe declarations of package patchright it uses was added/);
  assert.equal(executed(root), false);
});
