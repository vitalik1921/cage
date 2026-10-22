import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { CheckReport } from "../src/check.ts";
import type { TypeScript } from "../src/typescript.ts";
import { cli, contract, designProject, mdx, PROJECT_OPTIONS, writeFile } from "./helpers.ts";

const require = createRequire(import.meta.url);
const compilers = ["typescript-5", "typescript"] as const;
const declaration = [
  "export interface SQLWrapper { getSQL(): string; }",
  "export declare class Query implements SQLWrapper { all(): string; }",
  "export interface Database { query: Query; }",
  "export interface Clean { id: string; }",
  "",
].join("\n");

function project(t: TestContext, compiler: (typeof compilers)[number], selected: boolean, skipLibCheck: boolean): string {
  const name = selected ? "Database" : "Clean";
  const root = designProject(t, { reader: mdx(`import type { ${name} } from "database-kit";\n${contract("Reader", `read(): ${name};`)}`) }, {
    "package.json": JSON.stringify({ name: "reader-app", type: "module", dependencies: { "database-kit": "1.0.0" } }),
    // The selected config and its inherited options must win over a different default config.
    "tsconfig.json": JSON.stringify({ compilerOptions: { ...PROJECT_OPTIONS, skipLibCheck: !skipLibCheck } }),
    "tsconfig.app.json": JSON.stringify({ extends: "./config/base.json", include: ["src/**/*.ts"] }),
    "config/base.json": JSON.stringify({ compilerOptions: { ...PROJECT_OPTIONS, types: [], skipLibCheck } }),
    ".cage/config.json": JSON.stringify({ version: 1, tsconfig: "tsconfig.app.json", review: "off", coverage: "require" }),
    "node_modules/database-kit/package.json": JSON.stringify({ name: "database-kit", version: "1.0.0", types: "index.d.ts" }),
    "node_modules/database-kit/index.d.ts": declaration,
    "src/reader/reader.ts": `import type { ${name} } from "database-kit";\ndeclare const value: ${name};\n/** @implements Reader */\nexport class Reader { read(): ${name} { return value; } }\n`,
  });
  fs.symlinkSync(path.resolve(import.meta.dirname, "../node_modules", compiler), path.join(root, "node_modules/typescript"), "dir");
  return root;
}

/** @tests Cli
 * @covers package-types */
test("package diagnostics honor the selected tsconfig and inherited skipLibCheck on TS 5 and 6", (t) => {
  for (const compiler of compilers) for (const skipLibCheck of [true, false]) for (const selected of [true, false]) {
    const root = project(t, compiler, selected, skipLibCheck);
    const ts = require(compiler) as TypeScript;
    // Independent compiler result, without Cage's option loader or diagnostic selection.
    const config = ts.getParsedCommandLineOfConfigFile(path.join(root, "tsconfig.app.json"), {}, {
      ...ts.sys, onUnRecoverableConfigFileDiagnostic: (error) => assert.fail(ts.flattenDiagnosticMessageText(error.messageText, "\n")),
    })!;
    const program = ts.createProgram(config.fileNames, config.options);
    const compilerErrors = ts.getPreEmitDiagnostics(program).filter((error) => error.category === ts.DiagnosticCategory.Error);
    assert.deepEqual(compilerErrors.map((error) => error.code), skipLibCheck ? [] : [2420]);
    const checked = cli(root, "check", "--format", "json");
    const report = JSON.parse(checked.stdout) as CheckReport;
    assert.equal(report.scope.typescript.source, "project");
    assert.equal(report.scope.typescript.version, compiler === "typescript-5" ? "5.9.3" : "6.0.3");
    assert.equal(report.scope.tsconfig, "tsconfig.app.json");
    const errors = report.diagnostics.filter(({ severity }) => severity === "error");
    const blocks = selected && !skipLibCheck;
    assert.equal(checked.code, blocks ? 1 : 0, checked.stdout);
    assert.deepEqual(errors.map(({ code }) => code), blocks ? ["E_DESIGN_IMPORT"] : []);
    if (blocks) assert.match(errors[0].message, /TS2420/);
    assert.equal(cli(root, "gate").code, blocks ? 2 : 0);
  }
});

/** @tests Cli
 * @covers package-types exact-signatures gate */
test("skipping a dependency's type errors never skips contract comparison or missing dependency checks", (t) => {
  for (const compiler of compilers) {
    const root = project(t, compiler, true, true);
    assert.equal(cli(root, "gate").code, 0);
    writeFile(root, "src/reader/reader.ts", '/** @implements Reader */\nexport class Reader { read(): number { return 1; } }\n');
    const drift = JSON.parse(cli(root, "check", "--format", "json").stdout) as CheckReport;
    assert.ok(drift.diagnostics.some(({ code }) => code === "E_TYPE_MISMATCH"));
    assert.equal(cli(root, "gate").code, 2);
    writeFile(root, "node_modules/database-kit/index.d.ts", 'export type Database = import("missing-database-driver").Database;\n');
    const missing = JSON.parse(cli(root, "check", "--format", "json").stdout) as CheckReport;
    assert.ok(missing.diagnostics.some(({ code }) => code === "E_DESIGN_IMPORT"));
    assert.equal(cli(root, "gate").code, 2);
  }
});

/** @tests Cli
 * @covers package-types */
test("missing selected imports retain their compiler diagnostic anchors for every binding form", (t) => {
  for (const compiler of compilers) for (const skipLibCheck of [true, false]) {
    const root = project(t, compiler, true, skipLibCheck);
    const check = () => (JSON.parse(cli(root, "check", "--phase", "design", "--format", "json").stdout) as CheckReport).diagnostics.filter(({ severity }) => severity === "error");
    for (const [binding, selected] of [
      ['import type { Gone } from "missing-driver";', "Gone"],
      ['import type Gone from "missing-driver";', "Gone"],
      ['import type * as Gone from "missing-driver";', "Gone.Result"],
      ['import Gone = require("missing-driver");', "Gone.Result"],
    ]) {
      for (const suppression of ["", "// @ts-ignore\n", "// @ts-expect-error\n", "// @ts-nocheck\n"]) {
        writeFile(root, "node_modules/database-kit/index.d.ts", `${suppression}${binding}\nexport type Database = ${selected};\n`);
        const errors = check();
        assert.equal(errors.some(({ code }) => code === "E_DESIGN_IMPORT"), suppression === "", `${compiler}, skipLibCheck=${skipLibCheck}: ${suppression}${binding}: ${JSON.stringify(errors)}`);
      }
      writeFile(root, "node_modules/database-kit/index.d.ts", `${binding}\nexport interface Database { id: string; }\n`);
      assert.deepEqual(check(), [], "an unused missing import does not affect the selected shape");
    }
  }
});
