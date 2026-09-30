import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { checkDesignPhase } from "../src/design-phase.ts";
import { CAMPAIGNS, checkDesigns, copyFixture, editFile, find, fixturesDir, generated, MAIL, QUOTA, summary, writeFile } from "./helpers.ts";

const breakQuota = (root: string) =>
  editFile(root, QUOTA, (s) => s.replace("take(accountId: AccountId)", "take(accountId: AccountIdd)"));

const editTsconfig = (root: string, compilerOptions: object) =>
  editFile(root, "tsconfig.json", (s) => {
    const config = JSON.parse(s);
    Object.assign(config.compilerOptions, compilerOptions);
    return JSON.stringify(config, null, 2);
  });

test("the plan fixture passes the design phase with no generated files on disk", () => {
  const root = path.join(fixturesDir, "vertical");
  const { modules, diagnostics } = checkDesigns(root);

  assert.deepEqual(diagnostics, []);
  assert.deepEqual(
    modules.map((module) => [module.moduleId, module.blocks.length]),
    [
      ["src/modules/campaigns", 1],
      ["src/modules/mail", 1],
      ["src/modules/quota", 2],
    ],
  );
  // Quota's second block uses AccountId from its first block; Send imports it
  // through quota's future design.generated.ts. Neither file exists.
  for (const module of modules) assert.equal(fs.existsSync(module.generatedFile), false);
});

test("a type error in the second block is reported at its MDX location", (t) => {
  const root = copyFixture(t, "vertical");
  const text = breakQuota(root);

  const { diagnostics } = checkDesigns(root);
  assert.deepEqual(diagnostics.map(summary), [{ code: "E_TYPESCRIPT", tsCode: 2552, file: QUOTA, ...find(text, "AccountIdd") }]);
});

test("blocks share one module scope: cross-block conflicts point at both blocks", (t) => {
  const root = copyFixture(t, "vertical");
  const text = editFile(root, QUOTA, (s) =>
    s
      .replace("export type AccountId = string;", "export type AccountId = string;\nexport interface Limits { daily: number }")
      .replace("  take(accountId: AccountId): Promise<boolean>;\n}\n", "  take(accountId: AccountId): Promise<boolean>;\n}\n\nexport interface Limits { daily: string }\n")
      .replace("export interface Quota {", "export type AccountId = number;\n\nexport interface Quota {"),
  );

  const { diagnostics } = checkDesigns(root);
  const first = find(text, "export type AccountId = string");
  const second = find(text, "export type AccountId = number");
  const offset = "export type ".length;
  assert.deepEqual(diagnostics.map(summary), [
    { code: "E_TYPESCRIPT", tsCode: 2300, file: QUOTA, line: first.line, column: first.column + offset },
    { code: "E_TYPESCRIPT", tsCode: 2300, file: QUOTA, line: second.line, column: second.column + offset },
    { code: "E_TYPESCRIPT", tsCode: 2717, file: QUOTA, ...find(text, "daily: string") },
  ]);
  const declared = find(text, "daily: number");
  assert.deepEqual(diagnostics[2].related, [
    {
      message: "'daily' was also declared here.",
      file: QUOTA,
      ...declared,
      endLine: declared.line,
      endColumn: declared.column + "daily".length,
    },
  ]);
});

test("locations stay exact with a byte order mark, CRLF line endings and non-ASCII text", (t) => {
  const root = copyFixture(t, "vertical");
  const text = editFile(root, QUOTA, (s) =>
    s
      .replace(
        "  take(accountId: AccountId): Promise<boolean>;\n}\n",
        [
          "  take(accountId: AccountId): Promise<boolean>;",
          "}",
          "",
          "/** Навмисна помилка: несумісне розширення 🙂. */",
          "export interface /* 🙂 ’ */ BrokenQuota extends Quota {",
          "  take(accountId: AccountId): Promise<string>;",
          "}",
          "",
        ].join("\n"),
      )
      .replaceAll("\n", "\r\n"),
  );
  const expected = [{ code: "E_TYPESCRIPT", tsCode: 2430, file: QUOTA, ...find(text, "BrokenQuota") }];

  const { modules, diagnostics } = checkDesigns(root);
  assert.deepEqual(diagnostics.map(summary), expected);
  assert.ok(!modules.at(-1)!.generated.text.includes("\r"));

  // Editors do not count the mark as a column, and neither does the report.
  writeFile(root, QUOTA, `${String.fromCharCode(0xfeff)}${text}`);
  const withMark = checkDesigns(root);
  assert.deepEqual(withMark.diagnostics.map(summary), expected);
  assert.equal(withMark.modules.at(-1)!.generated.text, modules.at(-1)!.generated.text);
});

for (const extension of [".ts", ".js"]) {
  test(`a cross-design import via a ${extension} specifier resolves the future generated file`, (t) => {
    const root = copyFixture(t, "vertical");
    const text = editFile(root, CAMPAIGNS, (s) =>
      s.replace(
        'import type { AccountId } from "../../quota/.design/design.generated.ts";',
        `import type { AccountId, Missing } from "../../quota/.design/design.generated${extension}";`,
      ),
    );

    const { diagnostics } = checkDesigns(root);
    assert.deepEqual(diagnostics.map(summary), [{ code: "E_TYPESCRIPT", tsCode: 2305, file: CAMPAIGNS, ...find(text, "Missing") }]);
  });
}

test("stale or broken generated files on disk never replace the fresh MDX", (t) => {
  const root = copyFixture(t, "vertical");
  for (const module of checkDesigns(root).modules) fs.writeFileSync(module.generatedFile, module.generated.text);
  writeFile(root, generated(MAIL), "export interface Sender { this is not TypeScript");
  const text = breakQuota(root);

  const { diagnostics } = checkDesigns(root);
  assert.deepEqual(diagnostics.map(summary), [{ code: "E_TYPESCRIPT", tsCode: 2552, file: QUOTA, ...find(text, "AccountIdd") }]);
});

test("plain ts blocks stay examples: not extracted and not type-checked", (t) => {
  const root = copyFixture(t, "vertical");
  editFile(root, QUOTA, (s) =>
    s.replace(
      "## Контракт",
      ["```ts", "/** @contract */", "export interface Quota { this is not TypeScript", "```", "", "## Контракт"].join("\n"),
    ),
  );

  const { modules, diagnostics } = checkDesigns(root);
  assert.deepEqual(diagnostics, []);
  assert.equal(modules.at(-1)!.blocks.length, 2);
  assert.ok(!modules.at(-1)!.generated.text.includes("this is not TypeScript"));
});

test("document errors are reported alone, without compiler cascades", (t) => {
  const root = copyFixture(t, "vertical");
  const text = editFile(root, QUOTA, (s) => s.replace("## Типи", "## Типи {1 +}"));

  const { diagnostics } = checkDesigns(root);
  assert.deepEqual(
    diagnostics.map(({ code, file, line }) => ({ code, file, line })),
    [{ code: "E_MDX_SYNTAX", file: QUOTA, line: find(text, "## Типи").line }],
  );
});

test("each block must be complete on its own: an open declaration is reported where the block ends", (t) => {
  const root = copyFixture(t, "vertical");
  const text = editFile(root, QUOTA, (s) => s.replace("Promise<boolean>;\n}\n```", "Promise<boolean>;\n```"));
  const lastLine = find(text, "take(accountId: AccountId)");

  const { diagnostics } = checkDesigns(root);
  assert.deepEqual(diagnostics.map(summary), [
    { code: "E_TYPESCRIPT", tsCode: 1005, file: QUOTA, line: lastLine.line, column: "  take(accountId: AccountId): Promise<boolean>;".length + 1 },
  ]);
  assert.equal(diagnostics[0].message, "'}' expected.");
});

test("a comment left open in one block cannot absorb the next block", (t) => {
  const root = copyFixture(t, "vertical");
  const text = editFile(root, QUOTA, (s) => s.replace("export type AccountId = string;", "export type AccountId = string;\n/** open"));
  const open = find(text, "/** open");

  // Joined into one module the text would be valid TypeScript: the comment
  // would run on to the end of the JSDoc that opens the second block.
  const { diagnostics } = checkDesigns(root);
  assert.deepEqual(diagnostics.map(summary), [
    { code: "E_TYPESCRIPT", tsCode: 1010, file: QUOTA, line: open.line, column: "/** open".length + 1 },
  ]);
});

test("@ts-nocheck cannot switch off the type check of a design", (t) => {
  const root = copyFixture(t, "vertical");
  const text = editFile(root, MAIL, (s) => s.replace("```ts design\n", "```ts design\n// A comment first.\n// @ts-nocheck\nexport type Bad = NotThere;\n"));

  const { diagnostics } = checkDesigns(root);
  assert.deepEqual(diagnostics.map(summary), [
    { code: "E_UNSUPPORTED_DECLARATION", tsCode: undefined, file: MAIL, ...find(text, "// @ts-nocheck") },
  ]);

  // Below the first declaration the compiler ignores the pragma, and so do we.
  editFile(root, MAIL, (s) => s.replace("// @ts-nocheck\nexport type Bad = NotThere;\n", "export type Bad = NotThere;\n// @ts-nocheck\n"));
  assert.deepEqual(
    checkDesigns(root).diagnostics.map(({ code, tsCode }) => ({ code, tsCode })),
    [{ code: "E_TYPESCRIPT", tsCode: 2304 }],
  );
});

test("an unusable TypeScript configuration is an environment error", async (t) => {
  await t.test("missing tsconfig", (t) => {
    const root = copyFixture(t, "vertical");
    fs.rmSync(path.join(root, "tsconfig.json"));
    assert.deepEqual(checkDesigns(root).diagnostics.map(summary), [
      { code: "E_ENVIRONMENT", tsCode: 5083, file: "tsconfig.json", line: undefined, column: undefined },
    ]);
  });

  await t.test("invalid option syntax", (t) => {
    const root = copyFixture(t, "vertical");
    const text = editFile(root, "tsconfig.json", (s) => s.replace('"strict": true', '"strict": tru'));
    assert.deepEqual(checkDesigns(root).diagnostics.map(summary), [
      { code: "E_ENVIRONMENT", tsCode: 5024, file: "tsconfig.json", ...find(text, "tru") },
    ]);
  });

  await t.test("invalid option value", (t) => {
    const root = copyFixture(t, "vertical");
    const text = editTsconfig(root, { module: "Nope" });
    assert.deepEqual(checkDesigns(root).diagnostics.map(summary), [
      { code: "E_ENVIRONMENT", tsCode: 6046, file: "tsconfig.json", ...find(text, '"Nope"') },
    ]);
  });

  await t.test("type definitions that cannot be found", (t) => {
    const root = copyFixture(t, "vertical");
    breakQuota(root);
    editTsconfig(root, { types: ["not-installed"] });
    // The type error in the design is not reported: nothing is reliable without the requested types.
    assert.deepEqual(
      checkDesigns(root).diagnostics.map(({ code, tsCode, file }) => ({ code, tsCode, file })),
      [{ code: "E_ENVIRONMENT", tsCode: 2688, file: "tsconfig.json" }],
    );
  });
});

test("options that TypeScript 6 deprecates but a TypeScript 5 project uses are accepted", (t) => {
  const root = copyFixture(t, "vertical");
  editTsconfig(root, { baseUrl: ".", paths: { "@quota/*": ["src/modules/quota/*"] } });
  editFile(root, CAMPAIGNS, (s) => s.replace('"../../quota/.design/design.generated.ts"', '"@quota/.design/design.generated.ts"'));
  assert.deepEqual(checkDesigns(root).diagnostics, []);

  // The alias really resolves to the overlay: a member it does not export is an error.
  const text = editFile(root, CAMPAIGNS, (s) => s.replace("import type { AccountId }", "import type { AccountId, Missing }"));
  assert.deepEqual(checkDesigns(root).diagnostics.map(summary), [
    { code: "E_TYPESCRIPT", tsCode: 2305, file: CAMPAIGNS, ...find(text, "Missing") },
  ]);
});

test("options that only lay out emitted files do not reject a design", (t) => {
  const root = copyFixture(t, "vertical");
  editTsconfig(root, { rootDir: "lib", outDir: "dist", declaration: true, composite: true, noEmit: false, allowImportingTsExtensions: false, rewriteRelativeImportExtensions: true });
  assert.deepEqual(checkDesigns(root).diagnostics, []);
});

test("locations in the bundled TypeScript library do not depend on where the harness is installed", (t) => {
  const root = copyFixture(t, "vertical");
  editFile(root, MAIL, (s) => s.replace("export interface Sender {", "declare global {\n  var Promise: number;\n}\n\nexport interface Sender {"));

  const files = checkDesigns(root).diagnostics.flatMap((diagnostic) => (diagnostic.related ?? []).map((related) => related.file));
  assert.ok(files.length > 0);
  for (const file of files) assert.match(file!, /^typescript\/lib\/lib\.[a-z0-9.]+\.d\.ts$/);
});

test("an empty scope or an unreadable design is an error, not an empty success", (t) => {
  const root = copyFixture(t, "vertical");
  const phase = (sourceFiles: string[]) =>
    checkDesignPhase({
      root,
      tsconfig: "tsconfig.json",
      designs: sourceFiles.map((file) => ({ moduleId: file, sourceFile: path.join(root, file), generatedFile: path.join(root, generated(file)) })),
    });

  assert.deepEqual(phase([]).diagnostics.map(summary), [
    { code: "E_NO_DESIGNS", tsCode: undefined, file: undefined, line: undefined, column: undefined },
  ]);
  assert.deepEqual(phase([MAIL, "src/gone/.design/design.mdx"]).diagnostics.map(summary), [
    { code: "E_ENVIRONMENT", tsCode: undefined, file: "src/gone/.design/design.mdx", line: undefined, column: undefined },
  ]);
});
