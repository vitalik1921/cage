import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import type ts from "typescript";
import { createPackageDiagnostics } from "../src/package-diagnostics.ts";
import { createOverlayProgram, type TypeScript } from "../src/typescript.ts";
import { checkDesigns, contract, designProject, mdx, scratchDirectory } from "./helpers.ts";

const require = createRequire(import.meta.url);
const compilers = ["typescript-5", "typescript"] as const;

/** @tests Cli
 * @covers package-types */
test("selected package declarations surface compiler errors while honoring suppression", (t) => {
  for (const compiler of compilers) {
    for (const skipLibCheck of [false, true]) {
      for (const [declaration, expectedError] of [
        ["export type Shape = { id: string }['missing'];\n", true],
        ["export interface Shape { id: string", true],
        ["export interface Shape { id: string\n  \n", true],
        ["export interface Shape { id: string\n// trailing comment", true],
        ["export interface Shape { id: string\n/* trailing comment */", true],
        ["export type Shape = { id: string", true],
        ["// @ts-ignore\nexport type Shape = { id: string }['missing'];\n", false],
        ["// @ts-nocheck\nexport type Shape = { id: string }['missing'];\n", false],
        ["export type Shape = any;\n", false],
      ] as const) {
        const root = designProject(t, { reader: mdx('import type { Shape } from "kit";\n' + contract("Reader", "value: Shape;")) }, {
          "node_modules/kit/package.json": JSON.stringify({ name: "kit", version: "1.0.0", types: "index.d.ts" }),
          "node_modules/kit/index.d.ts": declaration,
          "tsconfig.json": JSON.stringify({ compilerOptions: {
            target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, skipLibCheck,
          } }),
        });
        fs.symlinkSync(path.resolve(import.meta.dirname, "../node_modules", compiler), path.join(root, "node_modules", "typescript"), "dir");
        const errors = checkDesigns(root).errors;
        assert.equal(errors.some((error) => error.code === "E_DESIGN_IMPORT"), expectedError, `${compiler}, skipLibCheck=${skipLibCheck}, ${declaration}`);
      }
    }
  }
});

/** @tests Cli
 * @covers package-types */
test("selected package globals retain the files that declare their shape", (t) => {
  for (const compiler of compilers) {
    const root = designProject(t, { reader: mdx('import type { Value } from "kit";\n' + contract("Reader", "value: Value;")) }, {
      "node_modules/kit/package.json": JSON.stringify({ name: "kit", version: "1.0.0", types: "index.d.ts" }),
      "node_modules/kit/index.d.ts": '/// <reference path="./globals.d.ts" />\nexport type Value = typeof globalThis;\n',
      "node_modules/kit/globals.d.ts": "export {};\ndeclare global { const Foo: { readonly v: string }; }\n",
    });
    fs.symlinkSync(path.resolve(import.meta.dirname, "../node_modules", compiler), path.join(root, "node_modules", "typescript"), "dir");
    const result = checkDesigns(root);
    assert.deepEqual(result.errors, [], compiler);
    const files = result.index.packages.flatMap((entry) => entry.files.map((file) => file.id));
    assert.ok(files.includes("kit@1.0.0/globals.d.ts"), `${compiler}: ${files.join(", ")}`);
  }
});

/** @tests Cli
 * @covers package-types */
test("selected merged declarations retain their augmenting package", (t) => {
  for (const compiler of compilers) {
    const root = designProject(t, { reader: mdx('import type { Value } from "kit";\n' + contract("Reader", "value: Value;")) }, {
      "node_modules/kit/package.json": JSON.stringify({ name: "kit", version: "1.0.0", types: "index.d.ts" }),
      "node_modules/kit/index.d.ts": 'import "addon";\nexport interface Value { readonly base: string; }\n',
      "node_modules/addon/package.json": JSON.stringify({ name: "addon", version: "1.0.0", types: "index.d.ts" }),
      "node_modules/addon/index.d.ts": 'import "kit";\ndeclare module "kit" { interface Value { readonly added: number; } }\n',
    });
    fs.symlinkSync(path.resolve(import.meta.dirname, "../node_modules", compiler), path.join(root, "node_modules", "typescript"), "dir");
    const result = checkDesigns(root);
    assert.deepEqual(result.errors, [], compiler);
    const files = result.index.packages.flatMap((entry) => entry.files.map((file) => file.id));
    assert.ok(files.includes("addon@1.0.0/index.d.ts"), `${compiler}: ${files.join(", ")}`);
  }
});

/** @tests Cli
 * @covers package-types */
test("selected package types cannot enter a source-only dependency", (t) => {
  for (const compiler of compilers) {
    const root = designProject(t, { reader: mdx('import type { Value } from "kit";\n' + contract("Reader", "value: Value;")) }, {
      "node_modules/kit/package.json": JSON.stringify({ name: "kit", version: "1.0.0", types: "index.d.ts" }),
      "node_modules/kit/index.d.ts": 'export type Value = import("./impl.js").Value;\n',
      "node_modules/kit/impl.ts": "export interface Value { readonly x: string; }\n",
    });
    fs.symlinkSync(path.resolve(import.meta.dirname, "../node_modules", compiler), path.join(root, "node_modules", "typescript"), "dir");
    const errors = checkDesigns(root).errors;
    assert.ok(errors.some((error) => error.code === "E_DESIGN_IMPORT" && error.message.includes("not a declaration file")), `${compiler}: ${JSON.stringify(errors)}`);
  }
});

for (const compiler of compilers) {
  for (const skipLibCheck of [false, true]) {
    test(`package diagnostics select invalid declarations and honor directives (${compiler}, skipLibCheck=${skipLibCheck})`, (t) => {
      const ts = require(compiler) as TypeScript;
      const root = scratchDirectory(t, "package-diagnostics");
      const declarationPath = path.join(root, "node_modules", "kit", "index.d.ts");
      fs.mkdirSync(path.dirname(declarationPath), { recursive: true });
      fs.writeFileSync(path.join(path.dirname(declarationPath), "package.json"), JSON.stringify({ name: "kit", version: "1.0.0", types: "index.d.ts" }));
      fs.writeFileSync(declarationPath, [
        "type Box<T> = { value: T };",
        "export type BadIndex = { id: string }['missing'];",
        "export type BadGeneric = Box;",
        "export type Circular = Circular;",
        "// @ts-ignore",
        "export type Suppressed = { id: string }['missing'];",
        "export type Explicit = any;",
        "export type Unselected = { id: string }['missing'];",
        "// @ts-ignore",
        "export type IgnoredImport = typeof import('missing-one');",
        "export type MissingImport = typeof import('missing-two');",
        "export type BrokenSyntax = { value: ; };",
        "",
      ].join("\n"));
      const consumer = path.join(root, "consumer.ts");
      const overlay = createOverlayProgram(ts, {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        strict: true,
        noEmit: true,
        skipLibCheck,
        types: [],
      }, new Map([[consumer, 'import type { BadIndex } from "kit";\nexport type Public = BadIndex;\n']]));
      const source = overlay.program.getSourceFile(declarationPath)!;
      const names = new Map(source.statements.filter(ts.isTypeAliasDeclaration).map((node) => [node.name.text, node]));
      const selection = (name: string) => ({ declarations: new Map([[declarationPath, [names.get(name)!]]]) });
      let companions = 0;
      let semanticChecks = 0;
      const countedOverlay = { createProgram: ((names, alternative) => {
        companions++;
        const checked = overlay.createProgram(names, alternative);
        const semantic = checked.getSemanticDiagnostics;
        checked.getSemanticDiagnostics = (file, cancellationToken) => {
          semanticChecks++;
          return semantic(file, cancellationToken);
        };
        return checked;
      }) satisfies typeof overlay.createProgram };
      const diagnostics = createPackageDiagnostics(ts, countedOverlay, overlay.program);
      for (const [name, code] of [["BadIndex", 2339], ["BadGeneric", 2314], ["Circular", 2456]] as const) {
        assert.ok(diagnostics.diagnosticsFor(selection(name)).some((diagnostic) => diagnostic.code === code), `${compiler}: ${name}`);
      }
      assert.ok(diagnostics.diagnosticsFor(selection("BrokenSyntax")).some((diagnostic) => diagnostic.code === 1110), `${compiler}: syntax`);
      for (const name of ["Suppressed", "Explicit", "IgnoredImport"]) {
        assert.deepEqual(diagnostics.diagnosticsFor(selection(name)), [], `${compiler}: ${name}`);
      }
      assert.deepEqual(diagnostics.diagnosticsFor(selection("BadIndex")).map((diagnostic) => diagnostic.code), [2339], "unselected errors stay out");
      const anchor = (name: string) => {
        const node = names.get(name)!;
        const literal = node.type;
        assert.ok(ts.isImportTypeNode(literal));
        return literal.argument;
      };
      const ignored = anchor("IgnoredImport");
      const missing = anchor("MissingImport");
      assert.equal(diagnostics.hasErrorAt(declarationPath, ignored.getStart(source), ignored.getEnd()), false);
      assert.equal(diagnostics.hasErrorAt(declarationPath, missing.getStart(source), missing.getEnd()), true);
      if (skipLibCheck) {
        assert.equal(companions, 1, "one companion program per resolver");
        assert.equal(semanticChecks, 1, "one semantic check per declaration file");
      }
    });

    test(`package diagnostics respect file-level @ts-nocheck (${compiler}, skipLibCheck=${skipLibCheck})`, (t) => {
      const ts = require(compiler) as TypeScript;
      const root = scratchDirectory(t, "package-nocheck");
      const declarationPath = path.join(root, "kit.d.ts");
      fs.writeFileSync(declarationPath, "// @ts-nocheck\nexport type Broken = { id: string }['missing'];\n");
      const overlay = createOverlayProgram(ts, { noEmit: true, skipLibCheck, types: [] }, new Map([[declarationPath, fs.readFileSync(declarationPath, "utf8")]]));
      const source = overlay.program.getSourceFile(declarationPath)!;
      const diagnostics = createPackageDiagnostics(ts, overlay, overlay.program);
      assert.deepEqual(diagnostics.diagnosticsFor({ declarations: new Map([[declarationPath, [source.statements[0] as ts.Node]]]) }), []);
    });
  }
}
