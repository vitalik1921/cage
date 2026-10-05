import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { CheckReport } from "../src/check.ts";
import type { Diagnostic } from "../src/diagnostic.ts";
import type { ReviewIndex, ReviewReport } from "../src/review.ts";
import ts from "typescript";
import { collectMaterial, createFileReader, dependencyClosure } from "../src/review-material.ts";
import { checkLinking, cli, contract, designFile, designProject, editFile, mdx, writeFile } from "./helpers.ts";

// What makes a recorded review outdated beyond the contract, its implementation statement and its test
// statements: the code they rely on, in the same file and in the files they import, and the module's prose.
// The cases of the audit of 0.2.5, where each of these changed and a required review stayed fresh.

const lines = (...text: string[]) => `${text.join("\n")}\n`;
const DESIGN = designFile("quota");
const IMPLEMENTATION = "src/quota/memory-quota.ts";
const RULE = "src/quota/quota-rule.ts";
const TESTS = "src/quota/quota.test.ts";
const STUB = "src/quota/stub.ts";

const QUOTA = contract("Quota", "take(): boolean;", "@invariant empty An empty quota refuses.", "@invariant consume A successful take uses exactly one send.");

/** A Quota whose behaviour lives partly outside the tagged class: in a helper file, and in a function of its own file. */
function quotaProject(t: TestContext, files: Record<string, string> = {}, config: object = {}): string {
  const root = designProject(
    t,
    { quota: mdx(QUOTA).replace("What the module is for.", "Each account gets a number of sends; a send is refused when none are left.") },
    {
      [RULE]: "export const hasQuota = (left: number): boolean => left > 0;\n",
      "src/quota/types.ts": "export type Left = number;\n",
      [IMPLEMENTATION]: lines(
        'import { hasQuota } from "./quota-rule.ts";',
        'import type { Left } from "./types.ts";',
        "",
        "function decrement(left: Left): Left {",
        "  return left - 1;",
        "}",
        "",
        "export function unrelated(): number {",
        "  return 1;",
        "}",
        "",
        "/** @implements Quota */",
        "export class MemoryQuota {",
        "  left: Left = 2;",
        "  take(): boolean {",
        "    if (!hasQuota(this.left)) return false;",
        "    this.left = decrement(this.left);",
        "    return true;",
        "  }",
        "}",
      ),
      [STUB]: "export const fresh = <T>(Kind: new () => T): T => new Kind();\n",
      [TESTS]: lines(
        'import assert from "node:assert/strict";',
        'import { beforeEach, describe, it } from "node:test";',
        'import { MemoryQuota } from "./memory-quota.ts";',
        'import { fresh } from "./stub.ts";',
        "",
        "/** @tests Quota */",
        'describe("Quota", () => {',
        "  let quota: MemoryQuota;",
        "  beforeEach(() => {",
        "    quota = fresh(MemoryQuota);",
        "  });",
        "  /** @covers empty */",
        '  it("refuses when empty", () => {',
        "    quota.left = 0;",
        "    assert.equal(quota.take(), false);",
        "  });",
        "  /** @covers consume */",
        '  it("takes one send", () => {',
        "    assert.equal(quota.take(), true);",
        "    assert.equal(quota.left, 1);",
        "  });",
        "});",
      ),
      ".cage/config.json": JSON.stringify({ version: 1, review: "require", coverage: "off", ...config }),
      ...files,
    },
  );
  return root;
}

function check(root: string): { code: number; report: CheckReport } {
  const { code, stdout } = cli(root, "check", "--format", "json");
  return { code, report: JSON.parse(stdout) };
}

/** The packets of every contract: the index names them, the packets come by name. */
function packet(root: string): ReviewReport {
  const index = JSON.parse(cli(root, "review", "--all", "--format", "json").stdout) as ReviewIndex;
  return JSON.parse(cli(root, "review", ...index.contracts.map((entry) => entry.contract), "--format", "json").stdout);
}

/** Records an adequate verdict for every invariant of every contract, for the material as it is now; by default check is then clean. */
function recordAdequate(root: string, clean = true): void {
  const verdicts = packet(root).contracts.map(({ contract: name, fingerprint, invariants }) => ({
    contract: name,
    fingerprint,
    findings: invariants.map(({ id }) => ({ invariant: id, assessment: "adequate", reason: "Checked.", evidence: `${TESTS}:1`, suggestedChange: null })),
  }));
  writeFile(root, "verdicts.json", JSON.stringify({ version: 1, verdicts }));
  assert.equal(cli(root, "review", "--record", "verdicts.json").code, 0);
  if (!clean) return;
  const fresh = check(root);
  assert.equal(fresh.code, 0, fresh.report.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
}

/** The reasons of the outdated review of Quota, or undefined while it is fresh. */
function staleBecause(root: string): string | undefined {
  const { code, report } = check(root);
  const stale = report.diagnostics.find((diagnostic) => diagnostic.code === "E_REVIEW_STALE");
  if (stale) assert.equal(code, 1);
  // The parts, one a line in the message, joined as a list here.
  return stale && /since then:\n([\s\S]*)\nReview it again\./.exec(stale.message)?.[1].split("\n").map((line) => line.replace(/^- /, "")).join(", ");
}

test("a test file edited while review runs: the material is cut from the text the check read, not from the disk", (t) => {
  const root = quotaProject(t);
  const result = checkLinking(root);
  // Edited after the check read it, before the material is collected: the same lines, all empty. The locations of
  // the tests and of their beforeEach now point past the end of their lines on the disk.
  editFile(root, TESTS, (text) => text.replace(/[^\n]/g, ""));
  const diagnostics: Diagnostic[] = [];
  const material = collectMaterial(result, "Quota", createFileReader(root, diagnostics, result.linking.sources).read);
  assert.deepEqual(diagnostics, []);
  const tests = material.parts.filter((part) => part.key.startsWith("test "));
  assert.equal(tests.length, 2);
  for (const part of tests) assert.match(part.text, /beforeEach\(\(\) => \{\n {4}quota = fresh\(MemoryQuota\);/);
  assert.match(tests.map((part) => part.text).join("\n"), /assert\.equal\(quota\.left, 1\);/);
});

test("a change in a file the implementation imports makes the review outdated (audit P0)", (t) => {
  const root = quotaProject(t);
  recordAdequate(root);
  // The helper alone changes; tags, tests and types stay as they were.
  editFile(root, RULE, () => "export const hasQuota = (_left: number): boolean => false;\n");
  assert.equal(staleBecause(root), `dependency ${RULE} changed`);
});

test("a function of the implementation's own file that it calls is part of it; one it does not call is not", (t) => {
  const root = quotaProject(t);
  recordAdequate(root);
  editFile(root, IMPLEMENTATION, (text) => text.replace("  return 1;", "  return 2;"));
  assert.equal(staleBecause(root), undefined);
  editFile(root, IMPLEMENTATION, (text) => text.replace("  return left - 1;", "  return left - 2;"));
  assert.equal(staleBecause(root), `implementation MemoryQuota (${IMPLEMENTATION}) changed`);
});

test("a stub the tests import, and the setup of their suite, are part of what the tests observe", (t) => {
  const root = quotaProject(t);
  recordAdequate(root);
  editFile(root, STUB, () => "export const fresh = <T>(Kind: new () => T): T => Object.assign(new Kind() as object, { left: 99 }) as T;\n");
  assert.equal(staleBecause(root), `dependency ${STUB} changed`);
  recordAdequate(root);
  // The suite's beforeEach belongs to both tests.
  editFile(root, TESTS, (text) => text.replace("quota = fresh(MemoryQuota);", "quota = new MemoryQuota();"));
  assert.equal(staleBecause(root), `test "refuses when empty" (${TESTS}) changed, test "takes one send" (${TESTS}) changed`);
});

test("a change of the module's prose makes the review outdated; another contract's declaration in the same document does not (audit P1)", (t) => {
  const root = quotaProject(t, {
    [DESIGN]: mdx(QUOTA, contract("Ledger", "note(): void;", "@invariant noted A take is noted.")).replace("What the module is for.", "Each account gets a number of sends; a send is refused when none are left."),
    "src/quota/ledger.ts": "/** @implements Ledger */\nexport const ledger = { note: (): void => {} };\n",
    "src/quota/ledger.test.ts": lines('import assert from "node:assert/strict";', 'import { it } from "node:test";', "/** @tests Ledger", " * @covers noted */", 'it("notes", () => { assert.ok(true); });'),
  });
  recordAdequate(root);
  // Another contract's declaration is that contract's material, not this one's.
  editFile(root, DESIGN, (text) => text.replace("@invariant noted A take is noted.", "@invariant noted A take is noted once."));
  const after = check(root).report.diagnostics.filter((diagnostic) => diagnostic.code === "E_REVIEW_STALE").map((diagnostic) => diagnostic.contract);
  assert.deepEqual(after, ["Ledger"]);
  recordAdequate(root);
  // The prose is every contract's business context.
  editFile(root, DESIGN, (text) => text.replace("a send is refused when none are left", "both sends go through"));
  assert.deepEqual(
    check(root).report.diagnostics.filter((diagnostic) => diagnostic.code === "E_REVIEW_STALE").map((diagnostic) => [diagnostic.contract, /since then:\n- (.*)\nReview/.exec(diagnostic.message)?.[1]]),
    [
      ["Quota", `the prose of ${DESIGN} changed`],
      ["Ledger", `the prose of ${DESIGN} changed`],
    ],
  );
});

test("a type-only import is not a dependency: types do not run", (t) => {
  const root = quotaProject(t);
  recordAdequate(root);
  editFile(root, "src/quota/types.ts", () => "export type Left = number; // counted in sends\n");
  assert.equal(staleBecause(root), undefined);
  assert.deepEqual(packet(root).contracts[0].fingerprinted, [RULE, STUB]);
});

test("another contract's implementation is fingerprinted, not followed: what it imports is that contract's material", (t) => {
  const root = quotaProject(t, {
    [RULE]: 'import { clock } from "./clock.ts";\n/** @implements Rule */\nexport const rule = { allows: (left: number): boolean => left > clock.now() * 0 };\nexport const hasQuota = (left: number): boolean => rule.allows(left);\n',
    "src/quota/clock.ts": "export const clock = { now: (): number => 1 };\n",
    [DESIGN]: mdx(QUOTA, contract("Rule", "allows(left: number): boolean;", "@invariant positive Allows a positive balance.")),
    "src/quota/rule.test.ts": lines('import assert from "node:assert/strict";', 'import { it } from "node:test";', 'import { rule } from "./quota-rule.ts";', "/** @tests Rule", " * @covers positive */", 'it("allows one", () => { assert.ok(rule.allows(1)); });'),
  });
  const quota = packet(root).contracts.find((entry) => entry.contract === "Quota")!;
  assert.deepEqual(quota.fingerprinted, [RULE, STUB]);
  recordAdequate(root);
  editFile(root, "src/quota/clock.ts", () => "export const clock = { now: (): number => 2 };\n");
  const stale = check(root).report.diagnostics.filter((diagnostic) => diagnostic.code === "E_REVIEW_STALE").map((diagnostic) => diagnostic.contract);
  assert.deepEqual(stale, ["Rule"]);
});

test("what lies beyond the bounds is reported, never silent; exclude takes a file out deliberately", (t) => {
  const chain = {
    [RULE]: 'import { a } from "./a.ts";\nexport const hasQuota = (left: number): boolean => left > a;\n',
    "src/quota/a.ts": 'import { b } from "./b.ts";\nexport const a = b;\n',
    "src/quota/b.ts": 'import { c } from "./c.ts";\nexport const b = c;\n',
    "src/quota/c.ts": "export const c = 0;\n",
  };
  // Depth 2: the rule and a.ts are followed; b.ts is two imports from the implementation's file... and three from the tests'.
  const shallow = quotaProject(t, chain, { reviewDependencies: { depth: 2 } });
  recordAdequate(shallow, false);
  const warned = check(shallow).report.diagnostics.find((diagnostic) => diagnostic.code === "E_REVIEW_SCOPE_LIMIT");
  // Under "review": "require" the limit is an error, so that it cannot pass unnoticed in CI.
  assert.ok(warned);
  assert.match(warned.message, /^The fingerprint of the review of contract "Quota" stops at the bounds of `reviewDependencies` \(3 dependency files fingerprinted\); a change in these would not make the review outdated:\n- src\/quota\/b\.ts \(past the depth\)\nThe bounds are the project's setting\.$/);
  // The message states the fact; it sends nobody to the configuration, because an agent reads it.
  assert.doesNotMatch(warned.message, /config\.json|Raise|exclude/);
  assert.deepEqual(packet(shallow).contracts[0].fingerprinted, [RULE, STUB, "src/quota/a.ts"]);
  // The packet and the index do not carry it at all: the fingerprinted files say what is covered.
  assert.ok(!packet(shallow).contracts[0].diagnostics.some((diagnostic) => diagnostic.code.endsWith("REVIEW_SCOPE_LIMIT")));
  assert.ok(!(JSON.parse(cli(shallow, "review", "--all", "--format", "json").stdout) as ReviewIndex).diagnostics.some((diagnostic) => diagnostic.code.endsWith("REVIEW_SCOPE_LIMIT")));

  const few = quotaProject(t, chain, { review: "warn", reviewDependencies: { maxFiles: 1 } });
  const limited = check(few).report.diagnostics.find((diagnostic) => diagnostic.code === "W_REVIEW_SCOPE_LIMIT");
  assert.equal(limited, undefined, "nothing is recorded yet: the limit is about a recorded review");
  assert.deepEqual(packet(few).contracts[0].fingerprinted, [RULE]);
  recordAdequate(few);
  assert.ok(check(few).report.diagnostics.some((diagnostic) => diagnostic.code === "W_REVIEW_SCOPE_LIMIT" && diagnostic.message.includes(`${STUB} (past the file limit)`)));

  // check reports a contract's own limit, not another's from the same document.
  const two = quotaProject(t, { ...chain, [DESIGN]: mdx(QUOTA, contract("Ledger", "note(): void;", "@invariant noted A take is noted.")), "src/quota/ledger.ts": "/** @implements Ledger */\nexport const ledger = { note: (): void => {} };\n", "src/quota/ledger.test.ts": lines('import assert from "node:assert/strict";', 'import { it } from "node:test";', "/** @tests Ledger", " * @covers noted */", 'it("notes", () => { assert.ok(true); });') }, { reviewDependencies: { depth: 1 } });
  recordAdequate(two, false);
  assert.deepEqual(check(two).report.diagnostics.filter((diagnostic) => diagnostic.code.endsWith("REVIEW_SCOPE_LIMIT")).map((diagnostic) => diagnostic.contract), ["Quota"]);

  const excluded = quotaProject(t, chain, { reviewDependencies: { exclude: ["src/quota/a.ts"] } });
  recordAdequate(excluded);
  assert.deepEqual(packet(excluded).contracts[0].fingerprinted, [RULE, STUB]);
  editFile(excluded, "src/quota/c.ts", () => "export const c = 5;\n");
  assert.equal(staleBecause(excluded), undefined);
});

test("bounds outside their range are a configuration error", (t) => {
  for (const reviewDependencies of [{ depth: 11 }, { maxFiles: -1 }, { exclude: [""] }, { follow: true }, []]) {
    const root = quotaProject(t, {}, { reviewDependencies });
    const { code, stdout } = cli(root, "check");
    assert.equal(code, 2);
    assert.match(stdout, /E_CONFIG: error at \.cage\/config\.json\n  "reviewDependencies" must be an object with "depth" \(0–10\), "maxFiles" \(0–1000\) and "exclude"/);
  }
});

test("a dependency that cannot be read is reported, not a silent hole", (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) return t.skip("file permissions do not apply");
  // A file the compiler's program holds fails earlier, as a source file; this is a file only the review reaches.
  const root = quotaProject(t);
  fs.chmodSync(path.join(root, STUB), 0o000);
  const closure = dependencyClosure(root, ts, { resolveFrom: (specifier, from) => (specifier.startsWith(".") ? path.resolve(path.dirname(from), specifier) : undefined) }, [{ file: TESTS, text: fs.readFileSync(path.join(root, TESTS), "utf8") }], new Set([TESTS, IMPLEMENTATION]), new Set(), { depth: 3, maxFiles: 40, exclude: [] });
  assert.deepEqual(closure.unreadable.map(({ file }) => file), [STUB]);
  assert.deepEqual(closure.files.map(({ file }) => file), []);
});

test("green output tells linked declarations, active ones, test execution and review attestation apart", (t) => {
  const root = quotaProject(t);
  recordAdequate(root);
  const { stdout } = cli(root, "check");
  assert.match(
    stdout,
    /^check: 1 design, 1 contract, 0 data types, 2 invariants, 1 implementation; tests: 2 declarations \(2 active\), 2 of 2 invariants linked, 2 to an active test, not run by cage; reviews: 2 attested adequate, 0 found weak, 0 unreviewed; 0 errors, 0 warnings\./m,
  );
});
