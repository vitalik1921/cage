import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { defaultConfig } from "../src/config.ts";
import { discoverDesigns, discoverSources, findFiles } from "../src/discovery.ts";
import { CAMPAIGNS, copyFixture, designProject, MAIL, QUOTA, readFile, writeFile } from "./helpers.ts";

const design = (root: string, file: string) => writeFile(root, file, readFile(root, MAIL));

test("finds the design documents, sorted, with their module and virtual file", (t) => {
  const root = copyFixture(t, "vertical");
  assert.deepEqual(discoverDesigns(root, defaultConfig), [
    { moduleId: "src/modules/campaigns", sourceFiles: [path.join(root, CAMPAIGNS)], virtualFile: path.join(root, path.posix.dirname(CAMPAIGNS), ".cage/design.ts") },
    { moduleId: "src/modules/mail", sourceFiles: [path.join(root, MAIL)], virtualFile: path.join(root, path.posix.dirname(MAIL), ".cage/design.ts") },
    { moduleId: "src/modules/quota", sourceFiles: [path.join(root, QUOTA)], virtualFile: path.join(root, path.posix.dirname(QUOTA), ".cage/design.ts") },
  ]);
});

test("the documents of one directory are one module; a parent and a nested directory are two modules", (t) => {
  const root = copyFixture(t, "vertical");
  design(root, "src/src.cage.mdx");
  design(root, "src/modules/quota/limits/limits.cage.mdx");
  design(root, "src/modules/quota/limits/more.cage.mdx");
  design(root, "root.cage.mdx");

  const config = { ...defaultConfig, designs: ["**/*.cage.mdx"] };
  assert.deepEqual(
    discoverDesigns(root, config).map((found) => [found.moduleId, found.sourceFiles.map((file) => path.basename(file))]),
    [
      [".", ["root.cage.mdx"]],
      ["src", ["src.cage.mdx"]],
      ["src/modules/campaigns", ["campaigns.cage.mdx"]],
      ["src/modules/mail", ["mail.cage.mdx"]],
      ["src/modules/quota", ["quota.cage.mdx"]],
      ["src/modules/quota/limits", ["limits.cage.mdx", "more.cage.mdx"]],
    ],
  );
  assert.equal(discoverDesigns(root, config).at(-1)?.virtualFile, path.join(root, "src/modules/quota/limits/.cage/design.ts"));
  // The default pattern does not reach the project root.
  assert.ok(!discoverDesigns(root, defaultConfig).some((found) => found.moduleId === "."));
});

test("only *.cage.mdx is a design document, whatever else the patterns match", (t) => {
  const root = copyFixture(t, "vertical");
  writeFile(root, "src/modules/quota/notes.mdx", "# Notes");
  writeFile(root, "src/modules/quota/.cage.mdx", "# A suffix alone is no name");
  writeFile(root, "src/modules/quota/docs/design.mdx", "# Not a design document");

  const config = { ...defaultConfig, designs: ["src/**/.cage/*", "src/**/*.mdx"] };
  assert.deepEqual(
    discoverDesigns(root, config).map((found) => [found.moduleId, found.sourceFiles.length]),
    [["src/modules/campaigns", 1], ["src/modules/mail", 1], ["src/modules/quota", 1]],
  );
});

test("exclude patterns remove designs; a configured list replaces the default one", (t) => {
  const root = copyFixture(t, "vertical");
  design(root, "src/node_modules/pkg/pkg.cage.mdx");
  design(root, "src/dist/dist.cage.mdx");

  const modules = (exclude: string[]) => discoverDesigns(root, { ...defaultConfig, exclude }).map((found) => found.moduleId);
  assert.deepEqual(modules(defaultConfig.exclude), ["src/modules/campaigns", "src/modules/mail", "src/modules/quota"]);
  assert.deepEqual(modules(["**/mail/**", "**/node_modules/**"]), ["src/dist", "src/modules/campaigns", "src/modules/quota"]);
  assert.deepEqual(modules(["src/modules/*/*.cage.mdx"]), ["src/dist", "src/node_modules/pkg"]);
});

test("symbolic links are not followed, inside or outside the project", (t) => {
  const root = copyFixture(t, "vertical");
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "design-harness-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  design(root, "elsewhere/elsewhere.cage.mdx");
  fs.cpSync(path.join(root, "elsewhere"), path.join(outside, "module"), { recursive: true });

  fs.symlinkSync(path.join(outside, "module"), path.join(root, "src/modules/outside"));
  fs.symlinkSync(path.join(root, "elsewhere"), path.join(root, "src/modules/inside"));
  fs.mkdirSync(path.join(root, "src/modules/linked"), { recursive: true });
  fs.symlinkSync(path.join(root, MAIL), path.join(root, "src/modules/linked/linked.cage.mdx"));

  assert.deepEqual(
    discoverDesigns(root, defaultConfig).map((found) => found.moduleId),
    ["src/modules/campaigns", "src/modules/mail", "src/modules/quota"],
  );
});

test("sources are .ts files: tests are not implementations, and declaration files are neither", (t) => {
  const root = designProject(t, {}, {
    "src/a.ts": "",
    "src/a.test.ts": "",
    "src/types.d.ts": "",
    "src/view.tsx": "",
    "src/esm.mts": "",
    "src/NOTES.md": "@implements Store",
    "tests/b.test.ts": "",
    "tests/helper.ts": "",
  });
  assert.deepEqual(discoverSources(root, { ...defaultConfig, implementations: ["src/**/*"], tests: ["src/**/*.test.*", "tests/**/*"] }), {
    implementations: ["src/a.ts"],
    tests: ["src/a.test.ts", "tests/b.test.ts", "tests/helper.ts"],
  });
});

test("findFiles walks only where a pattern can match", (t) => {
  const root = designProject(t, {});
  writeFile(root, "src/a.ts", "");
  writeFile(root, "src/deep/b.test.ts", "");
  writeFile(root, "tests/c.test.ts", "");
  writeFile(root, "scripts/d.ts", "");
  // A pattern that cannot be split into path segments is still matched, by walking everything.
  assert.deepEqual(findFiles(root, ["src/{deep/b,a}*.ts"], []), ["src/a.ts", "src/deep/b.test.ts"]);

  // Unreadable, and outside every pattern: never opened.
  fs.mkdirSync(path.join(root, "private"), { mode: 0o000 });
  try {
    assert.deepEqual(findFiles(root, ["src/**/*.ts"], ["**/*.test.ts"]), ["src/a.ts"]);
    assert.deepEqual(findFiles(root, ["src/**/*.test.ts", "tests/**/*.test.ts", "missing/**/*.ts"], []), ["src/deep/b.test.ts", "tests/c.test.ts"]);
    assert.deepEqual(findFiles(root, ["./tsconfig.json", "src/*.ts"], ["./tests/**"]), ["src/a.ts", "tsconfig.json"]);
    assert.deepEqual(findFiles(root, ["src/deep/**", "scripts/**"], []), ["scripts/d.ts", "src/deep/b.test.ts"]);
    assert.deepEqual(findFiles(root, ["{src,tests}/**/*.test.ts"], ["**/deep/**"]), ["tests/c.test.ts"]);
  } finally {
    fs.chmodSync(path.join(root, "private"), 0o700);
  }
});
