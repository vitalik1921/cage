import assert from "node:assert/strict";
import { test } from "node:test";
import ts from "typescript";
import ts5 from "typescript-5";
import { dependencySlices } from "../src/review-slice.ts";
import { fingerprintOf } from "../src/review-material.ts";

function material(compiler: typeof ts, root: string, dependencies: Record<string, string>) {
  const sources = new Map(Object.entries({ "root.ts": root, ...dependencies }).map(([file, text]) => [file, compiler.createSourceFile(file, text, compiler.ScriptTarget.Latest, true)]));
  const source = sources.get("root.ts")!;
  const slices = dependencySlices(compiler, sources, [{ file: "root.ts", nodes: [source.statements.at(-1)!] }], Object.keys(dependencies), new Set(), (specifier) => `${specifier}.ts`);
  const parts = [
    { key: "implementation root.ts#run", file: "root.ts", text: slices.roots[0].text },
    ...Object.entries(dependencies).map(([file, text]) => ({ key: `dependency ${file}`, file, text: slices.dependencies.get(file)?.text ?? text })),
  ];
  return { fingerprint: fingerprintOf(parts).fingerprint, slices };
}

const compilers = [ts, ts5 as unknown as typeof ts];
const helper = "export function configure() { return 1; }\nexport const unrelated = 123;\n";

/** @tests Cli
 * @covers review-dependency-relevant review-dependency-isolated */
test("module initialization selects imported helpers in control flow, namespaces, enums and export assignments", () => {
  for (const compiler of compilers) {
    for (const setup of [
      "if (true) configure();", "for (let i = 0; i < 1; i++) configure();", "try { configure(); } catch {}",
      "{ configure(); }", "switch (1) { case 1: configure(); }", "export default configure();",
      "enum Setup { Value = configure() }", "namespace Setup { configure(); }",
      "class Setup { [configure()]() {} }",
    ]) {
      const root = `import { configure } from "dep";\n${setup}\nexport const run = () => 1;`;
      const initial = material(compiler, root, { "dep.ts": helper });
      assert.match(initial.slices.dependencies.get("dep.ts")!.text, /function configure/, setup);
      assert.notEqual(initial.fingerprint, material(compiler, root, { "dep.ts": helper.replace("return 1", "return 2") }).fingerprint, setup);
      assert.equal(initial.fingerprint, material(compiler, root, { "dep.ts": helper.replace("unrelated = 123", "unrelated = 456") }).fingerprint, setup);
    }
  }
});

/** @tests Cli
 * @covers review-stale review-dependency-fallback */
test("retargeting an unused value import preserves observable dependency initialization order in the fingerprint", () => {
  for (const compiler of compilers) {
    const dependencies = { "a.ts": 'console.log("A"); export const value = 1;', "b.ts": 'console.log("B"); export const value = 2;' };
    const root = (target: string) => `import { value as unused } from "${target}";\nimport { value as a } from "a";\nimport { value as b } from "b";\nexport const run = () => a + b;`;
    const before = material(compiler, root("a"), dependencies);
    const after = material(compiler, root("b"), dependencies);
    assert.equal(before.slices.dependencies.get("a.ts"), undefined);
    assert.equal(before.slices.dependencies.get("b.ts"), undefined);
    assert.notEqual(before.fingerprint, after.fingerprint);
    assert.match(after.slices.roots[0].text, /value as unused.*"b"/);
  }
});

/** @tests Cli
 * @covers review-dependency-relevant review-dependency-isolated */
test("runner mocks and matcher setup select dependencies, while unrelated test registrations remain isolated", () => {
  for (const compiler of compilers) {
    for (const setup of [
      'import { mock } from "node:test"; mock.method({}, "value", configure);',
      'import { vi } from "vitest"; vi.stubGlobal("configure", configure);',
      'import { expect } from "vitest"; expect.extend({ configure });',
      'import * as v from "vitest"; v.vi.stubGlobal("configure", configure);',
      'import * as n from "node:test"; n.mock.method({}, "value", configure);',
    ]) {
      const root = `import { configure } from "dep";\n${setup}\nexport const run = () => 1;`;
      const before = material(compiler, root, { "dep.ts": helper });
      assert.match(before.slices.dependencies.get("dep.ts")!.text, /function configure/, setup);
      assert.notEqual(before.fingerprint, material(compiler, root, { "dep.ts": helper.replace("return 1", "return 2") }).fingerprint, setup);
      assert.equal(before.fingerprint, material(compiler, root, { "dep.ts": helper.replace("unrelated = 123", "unrelated = 456") }).fingerprint, setup);
    }
    for (const registration of [
      'import { test as other } from "node:test"; other("unrelated", () => configure());',
      'import other from "node:test"; other.describe("unrelated", () => other("nested", () => configure()));',
      'import * as n from "node:test"; n.it.skip("unrelated", () => configure());',
      'import { test as other } from "vitest"; other.concurrent.only("unrelated", () => configure());',
      'import * as v from "vitest"; v.test.each([1])("unrelated", () => configure());',
    ]) {
      const root = `import { configure } from "dep";\n${registration}\nexport const run = () => 1;`;
      const before = material(compiler, root, { "dep.ts": helper });
      assert.equal(before.slices.dependencies.get("dep.ts")!.text, "", registration);
      assert.equal(before.fingerprint, material(compiler, root, { "dep.ts": helper.replace("return 1", "return 2") }).fingerprint, registration);
    }
  }
});

/** @tests Cli
 * @covers review-dependency-relevant review-dependency-isolated */
test("suite registration executes setup while nested test callback dependencies remain isolated", () => {
  for (const compiler of compilers) {
    for (const runner of ["node:test", "vitest"]) {
      const dependencies = { "dep.ts": helper, "callback.ts": "export function unrelatedCallback() { return 123; }" };
      const root = `import { configure } from "dep";\nimport { unrelatedCallback } from "callback";\nimport { describe, test } from "${runner}";\ndescribe("other", () => { const title = configure(); test(String(title), () => unrelatedCallback()); });\nexport const run = () => 1;`;
      const before = material(compiler, root, dependencies);
      assert.match(before.slices.dependencies.get("dep.ts")!.text, /function configure/, runner);
      assert.notEqual(before.fingerprint, material(compiler, root, { ...dependencies, "dep.ts": helper.replace("return 1", "return 2") }).fingerprint, runner);
      assert.equal(before.slices.dependencies.get("callback.ts")!.text, "", runner);
      assert.equal(before.fingerprint, material(compiler, root, { ...dependencies, "callback.ts": dependencies["callback.ts"].replace("123", "456") }).fingerprint, runner);
    }
  }
});

/** @tests Cli
 * @covers review-stale review-dependency-fallback */
test("retargeting an effectful re-export also retains the root initialization connection", () => {
  for (const compiler of compilers) {
    const dependencies = { "a.ts": 'console.log("A"); export const value = 1;', "b.ts": 'console.log("B"); export const value = 2;' };
    const root = (target: string) => `export { value as unused } from "${target}";\nimport { value as a } from "a";\nimport { value as b } from "b";\nexport const run = () => a + b;`;
    assert.notEqual(material(compiler, root("a"), dependencies).fingerprint, material(compiler, root("b"), dependencies).fingerprint);
  }
});

/** @tests Cli
 * @covers review-dependency-relevant review-dependency-isolated */
test("registration titles and builders retain eagerly called helpers without retaining callback bodies", () => {
  for (const compiler of compilers) {
    const dependencies = {
      "dep.ts": "export function makeTitle() { return 'other'; }\nexport function loadFixtures() { return [1]; }\nexport const unrelated = 123;",
      "callback.ts": "export function unrelatedCallback() { return 123; }",
    };
    for (const registration of [
      'import { test } from "node:test"; test(makeTitle(), () => unrelatedCallback());',
      'import { test } from "node:test"; test(makeTitle(), unrelatedCallback);',
      'import { test } from "node:test"; test((() => makeTitle())(), () => unrelatedCallback());',
      'import { test } from "vitest"; test.each(loadFixtures())("other", () => unrelatedCallback());',
      'import * as v from "vitest"; v.describe.each(loadFixtures())("other", () => { v.test("nested", () => unrelatedCallback()); });',
      'import { test } from "vitest"; test.skipIf(makeTitle())("other", () => unrelatedCallback());',
    ]) {
      const root = `import { makeTitle, loadFixtures } from "dep";\nimport { unrelatedCallback } from "callback";\n${registration}\nexport const run = () => 1;`;
      const before = material(compiler, root, dependencies);
      assert.match(before.slices.dependencies.get("dep.ts")!.text, /function (makeTitle|loadFixtures)/, registration);
      assert.notEqual(before.fingerprint, material(compiler, root, { ...dependencies, "dep.ts": dependencies["dep.ts"].replace("'other'", "'changed'").replace("return [1]", "return [2]") }).fingerprint, registration);
      assert.equal(before.slices.dependencies.get("callback.ts")!.text, "", registration);
      assert.equal(before.fingerprint, material(compiler, root, { ...dependencies, "callback.ts": dependencies["callback.ts"].replace("return 123", "return 456") }).fingerprint, registration);
      assert.equal(before.fingerprint, material(compiler, root, { ...dependencies, "dep.ts": dependencies["dep.ts"].replace("unrelated = 123", "unrelated = 456") }).fingerprint, registration);
    }
  }
});

/** @tests Cli
 * @covers review-dependency-relevant */
test("eager registration helpers may synchronously invoke callback arguments", () => {
  for (const compiler of compilers) {
    const dependencies = {
      "dep.ts": "export function makeTitle(fn: () => string) { return fn(); }\nexport function configure() { return 'other'; }",
    };
    for (const title of ["makeTitle(configure)", "makeTitle(() => configure())"]) {
      const root = `import { makeTitle, configure } from "dep";\nimport { test } from "node:test";\ntest(${title}, () => {});\nexport const run = () => 1;`;
      const before = material(compiler, root, dependencies);
      assert.match(before.slices.dependencies.get("dep.ts")!.text, /function configure/, title);
      assert.notEqual(before.fingerprint, material(compiler, root, { "dep.ts": dependencies["dep.ts"].replace("'other'", "'changed'") }).fingerprint, title);
    }
  }
});
