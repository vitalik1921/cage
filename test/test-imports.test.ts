import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { CheckReport } from "../src/check.ts";
import { checkLinking, cli, copyFixture, editFile, writeFile } from "./helpers.ts";

const QUOTA_TEST = "src/modules/quota/quota.test.ts";
const FIXTURE = "src/modules/quota/quota-fixture.ts";
const HELPER = 'import { MemoryQuota } from "./memory-quota.ts";\n\nexport function quotaWith(initial: Record<string, number>): MemoryQuota {\n  return new MemoryQuota(initial);\n}\n';

/** The plan fixture with the Quota tests importing `imports` on line 4, after the runner and the implementation. */
function withImports(t: TestContext, imports: string, files: Record<string, string> = {}): string {
  const root = copyFixture(t, "vertical");
  writeFile(root, FIXTURE, HELPER);
  for (const [file, text] of Object.entries(files)) writeFile(root, file, text);
  editFile(root, QUOTA_TEST, (text) => text.replace('import { MemoryQuota } from "./memory-quota.ts";\n', `import { MemoryQuota } from "./memory-quota.ts";\n${imports}\n`));
  return root;
}
const quotaStatuses = (root: string) => checkLinking(root).linking.tests.filter((test) => test.contract === "Quota").map((test) => test.status);

test("a test file whose project import names something the file does not export runs none of its tests: they are broken-import", (t) => {
  const root = withImports(t, 'import { quotaWith } from "./quota-fixture.ts";');
  // In order, the import is nothing to report.
  assert.deepEqual(quotaStatuses(root), ["active", "active", "active", "active"]);
  assert.equal(cli(root, "check").code, 0);

  // The export is renamed: the compiler rejects the import, and Node would not load the file.
  editFile(root, FIXTURE, (text) => text.replace("quotaWith", "makeQuota"));
  const { linking, errors } = checkLinking(root);
  const quota = linking.tests.filter((declaration) => declaration.contract === "Quota");
  assert.deepEqual(quota.map(({ status }) => status), ["broken-import", "broken-import", "broken-import", "broken-import"]);
  const because = `its file has a broken import: "./quota-fixture.ts" (${QUOTA_TEST}:4) does not export "quotaWith"`;
  assert.ok(quota.every(({ inactiveBecause }) => inactiveBecause === because));
  assert.deepEqual(errors.map(({ code, invariant }) => ({ code, invariant })), ["accounts", "empty", "consume", "race"].map((invariant) => ({ code: "E_TEST_INACTIVE", invariant })));
  assert.match(errors[0].message, /^Quota\.accounts\n- "MemoryQuota > [^"]*" its file has a broken import: /);
  // The other contracts' tests are in another file and stay active.
  assert.ok(linking.tests.filter((declaration) => declaration.contract !== "Quota").every(({ status }) => status === "active"));

  const check = cli(root, "check", "--format", "json");
  const report = JSON.parse(check.stdout) as CheckReport;
  assert.equal(check.code, 1);
  assert.equal(report.counts.activeTestDeclarations, 4);
  assert.equal(report.counts.activeInvariants, 4);
  assert.equal(report.counts.executedTests, null);
  assert.match(cli(root, "check").stdout, /tests: 8 declarations \(4 active\), 8 of 8 invariants linked, 4 to an active test, not run by cage/);
});

test("a relative import of a script that resolves to no file, a default import without a default export and a missing side-effect import are broken", (t) => {
  for (const [imports, because] of [
    ['import { quotaWith } from "./gone.ts";', '"./gone.ts" (src/modules/quota/quota.test.ts:4) resolves to no file'],
    ['import "./setup-gone.ts";', '"./setup-gone.ts" (src/modules/quota/quota.test.ts:4) resolves to no file'],
    ['import quota from "./memory-quota.ts";', '"./memory-quota.ts" (src/modules/quota/quota.test.ts:4) does not export "default"'],
    ['import { quotaWith, other as renamed } from "./quota-fixture.ts";', '"./quota-fixture.ts" (src/modules/quota/quota.test.ts:4) does not export "other"'],
  ] as const) {
    const root = withImports(t, imports);
    const quota = checkLinking(root).linking.tests.filter((declaration) => declaration.contract === "Quota");
    assert.deepEqual(new Set(quota.map(({ status }) => status)), new Set(["broken-import"]), imports);
    assert.equal(quota[0].inactiveBecause, `its file has a broken import: ${because}`, imports);
  }
});

test("what the compiler cannot settle or the runtime erases does not make a test inactive", (t) => {
  for (const imports of [
    // Type-only imports are erased before the file runs, however wrong.
    'import type { Missing } from "./quota-fixture.ts";',
    'import { type Missing, quotaWith } from "./quota-fixture.ts";',
    // Packages are the runner's to resolve, and so are files that are not scripts.
    'import nothing from "a-package-that-is-not-installed";',
    'import data from "./data.json" with { type: "json" };',
    // A namespace import asks for no name; a re-export provides one; a side-effect import of a file that is there is in order.
    'import * as fixture from "./quota-fixture.ts";',
    'import { quotaWith as again } from "./barrel.ts";',
    'import "./quota-fixture.ts";',
  ]) {
    const root = withImports(t, imports, { "src/modules/quota/barrel.ts": 'export * from "./quota-fixture.ts";\n', "src/modules/quota/data.json": "{}\n" });
    assert.deepEqual(quotaStatuses(root), ["active", "active", "active", "active"], imports);
  }
});
