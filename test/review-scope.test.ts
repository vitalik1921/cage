import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { CheckReport } from "../src/check.ts";
import type { Diagnostic } from "../src/diagnostic.ts";
import type { ReviewIndex, ReviewReport } from "../src/review.ts";
import type { ReviewEntry } from "../src/review-record.ts";
import ts from "typescript";
import ts5 from "typescript-5";
import { collectMaterial, createFileReader, dependencyClosure, fingerprintOf } from "../src/review-material.ts";
import { dependencySlices } from "../src/review-slice.ts";
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
  return stale && stale.message.split("\n").slice(1).map((line) => line.replace(/^- /, "")).join(", ");
}

/** @tests Cli
 * @covers review-code-trivia review-packet review-stale */
test("comments in implementations, test setup, sliced config and whole-file helpers keep reviews current and stay in packets", (t) => {
  const root = quotaProject(t, {
    [RULE]: "export const limits = { minimum: 0 };\nexport const hasQuota = (left: number): boolean => left > limits.minimum;\n",
    // Mutable top-level state forces whole-file fallback.
    [STUB]: "let calls = 0;\nexport const fresh = <T>(Kind: new () => T): T => { calls++; return new Kind(); };\n",
  });
  recordAdequate(root);
  const before = packet(root).contracts[0].fingerprint;
  const reviewBefore = fs.readFileSync(path.join(root, ".cage/review.json"), "utf8");
  editFile(root, IMPLEMENTATION, (text) => text.replace("return left - 1;", "// Explanation in a selected helper.\n  return left - 1;").replace("left: Left = 2;", "/** Initial allowance. */\n  left: Left = 2;"));
  editFile(root, TESTS, (text) => text.replace("quota = fresh(MemoryQuota);", "// Explanation in setup.\n    quota = fresh(MemoryQuota);").replace("assert.equal(quota.take(), true);", "/* Explain the assertion. */ assert.equal( quota.take(), true );"));
  editFile(root, RULE, (text) => text.replace("minimum: 0", "\n  /** Explanation in config. */\n  minimum: 0\n"));
  editFile(root, STUB, (text) => `/** Explanation in whole-file fallback. */\n${text}`);
  assert.equal(staleBecause(root), undefined);
  assert.equal(packet(root).contracts[0].fingerprint, before);
  assert.deepEqual(JSON.parse(cli(root, "review", "--format", "json").stdout).contracts, []);
  const all = JSON.parse(cli(root, "review", "Quota", "--files", "all", "--format", "json").stdout) as ReviewReport;
  for (const file of [IMPLEMENTATION, TESTS, RULE, STUB]) assert.match(all.files.find((entry) => entry.path === file)!.text, /Explanation/);
  assert.equal(fs.readFileSync(path.join(root, ".cage/review.json"), "utf8"), reviewBefore);
  editFile(root, RULE, (text) => text.replace("minimum: 0", "minimum: 1"));
  assert.equal(staleBecause(root), `dependency ${RULE} changed`);
});

/** @tests Cli
 * @covers review-code-trivia review-stale */
test("annotation spacing keeps a recorded review current while Node coverage exclusions invalidate it", (t) => {
  const root = quotaProject(t);
  recordAdequate(root);
  const before = packet(root).contracts[0].fingerprint;
  editFile(root, IMPLEMENTATION, (text) => text.replace("/** @implements Quota */\n", "/** @implements Quota */\n\n"));
  editFile(root, TESTS, (text) => text.replace("/** @tests Quota */\n", "/** @tests Quota */\n\n").replace("/** @covers empty */\n", "/** @covers empty */\n\n"));
  assert.equal(staleBecause(root), undefined);
  assert.equal(packet(root).contracts[0].fingerprint, before);
  assert.deepEqual(JSON.parse(cli(root, "review", "--format", "json").stdout).contracts, []);
  editFile(root, IMPLEMENTATION, (text) => text.replace("    if (!hasQuota", "    /* node:coverage ignore next */\n    if (!hasQuota"));
  assert.equal(staleBecause(root), `implementation MemoryQuota (${IMPLEMENTATION}) changed`);
  assert.notEqual(packet(root).contracts[0].fingerprint, before);
});

/** @tests Cli
 * @covers review-code-trivia review-stale review-packet */
test("file directives outside selected declarations invalidate reviews and appear in default excerpts", (t) => {
  const root = quotaProject(t);
  for (const file of [IMPLEMENTATION, RULE]) editFile(root, file, (text) => `const unrelatedHeader = 1;\n${text}`);
  recordAdequate(root);
  for (const file of [IMPLEMENTATION, RULE]) {
    editFile(root, file, (text) => `// @ts-nocheck\n${text}`);
  }
  assert.match(staleBecause(root)!, /implementation MemoryQuota/);
  assert.match(staleBecause(root)!, /dependency .*quota-rule/);
  const changed = packet(root);
  for (const file of [IMPLEMENTATION, RULE]) {
    const excerpt = changed.excerpts.find((entry) => entry.file === file)!;
    assert.ok(excerpt.pieces.some((piece) => piece.startLine === 1 && piece.text.includes("// @ts-nocheck")));
    assert.doesNotMatch(excerpt.pieces.map((piece) => piece.text).join("\n"), /unrelatedHeader/);
    const sourceLines = fs.readFileSync(path.join(root, file), "utf8").split("\n");
    for (const piece of excerpt.pieces) assert.equal(piece.text, sourceLines.slice(piece.startLine - 1, piece.endLine).join("\n"));
  }
  recordAdequate(root);
  for (const file of [IMPLEMENTATION, RULE]) editFile(root, file, (text) => text.replace("// @ts-nocheck\nconst unrelatedHeader = 1;", "const unrelatedHeader = 1;\n// @ts-nocheck"));
  assert.match(staleBecause(root)!, /implementation MemoryQuota/);
  assert.match(staleBecause(root)!, /dependency .*quota-rule/);
});

/** @tests Cli
 * @covers review-fingerprint-legacy */
test("legacy reviews and acceptances stay current without migration until a new verdict is recorded", (t) => {
  for (const accepted of [false, true]) {
    const root = quotaProject(t);
    recordAdequate(root);
    const file = path.join(root, ".cage/review.json");
    const record = JSON.parse(fs.readFileSync(file, "utf8")) as { version: 1; reviews: ReviewEntry[] };
    const result = checkLinking(root);
    const material = collectMaterial(result, "Quota", createFileReader(root, [], result.linking.sources).read);
    const legacy = fingerprintOf(material.parts, "sha256:legacy");
    Object.assign(record.reviews[0], { fingerprint: legacy.fingerprint, material: legacy.digests, ...(accepted ? { accepted: true, findings: [] } : {}) });
    fs.writeFileSync(file, JSON.stringify(record));
    const before = fs.readFileSync(file, "utf8");
    assert.equal(staleBecause(root), undefined);
    assert.deepEqual(JSON.parse(cli(root, "review", "--format", "json").stdout).contracts, []);
    assert.equal(packet(root).contracts[0].recordedReview.status, accepted ? "accepted" : "current");
    assert.equal(cli(root, "review", "--accept").code, 0);
    assert.equal(fs.readFileSync(file, "utf8"), before);
    editFile(root, IMPLEMENTATION, (text) => text.replace("return left - 1;", "/* First explanation. */ return left - 1;"));
    assert.equal(staleBecause(root), `implementation MemoryQuota (${IMPLEMENTATION}) changed`);
    const changed = packet(root).contracts[0];
    assert.deepEqual(changed.changed.map((part) => part.kind), ["implementation"]);
    // Old verdicts cannot be submitted as if they had reviewed the new algorithm's material.
    writeFile(root, "old-verdict.json", JSON.stringify({ version: 1, verdicts: [{ contract: "Quota", fingerprint: legacy.fingerprint, findings: record.reviews[0].findings }] }));
    assert.notEqual(cli(root, "review", "--record", "old-verdict.json").code, 0);
    assert.equal(fs.readFileSync(file, "utf8"), before);
    recordAdequate(root);
    assert.match(JSON.parse(fs.readFileSync(file, "utf8")).reviews[0].fingerprint, /^sha256:code-v1:/);
    editFile(root, IMPLEMENTATION, (text) => text.replace("First explanation", "Better explanation"));
    assert.equal(staleBecause(root), undefined);
  }
});

/** @tests Cli
 * @covers review-dependency-relevant review-dependency-isolated review-packet */
test("dependency slices ignore unrelated declarations but include constants, helpers and matching excerpts", (t) => {
  const rule = lines("const threshold = 0;", "function positive(n: number): boolean { return n > threshold; }", "export const hasQuota = (left: number): boolean => positive(left);", "export function unrelated(): number { return 123; }");
  const root = quotaProject(t, { [RULE]: rule });
  recordAdequate(root);
  const before = packet(root).contracts[0].fingerprint;
  editFile(root, RULE, (text) => `\n\n${text.replace("return 123", "return 456")}`);
  assert.equal(staleBecause(root), undefined);
  assert.equal(packet(root).contracts[0].fingerprint, before);
  editFile(root, RULE, (text) => text.replace("threshold = 0", "threshold = 1"));
  assert.equal(staleBecause(root), `dependency ${RULE} changed`);
  const changed = packet(root);
  const excerpt = changed.excerpts.find((entry) => entry.file === RULE)!;
  assert.ok(excerpt);
  assert.match(excerpt.pieces.map((piece) => piece.text).join("\n"), /threshold = 1/);
  assert.doesNotMatch(excerpt.pieces.map((piece) => piece.text).join("\n"), /unrelated/);
  const sourceLines = fs.readFileSync(path.join(root, RULE), "utf8").split("\n");
  for (const piece of excerpt.pieces) assert.equal(piece.text, sourceLines.slice(piece.startLine - 1, piece.endLine).join("\n"));
  const all = JSON.parse(cli(root, "review", "Quota", "--files", "all", "--format", "json").stdout) as ReviewReport;
  assert.match(all.files.find((file) => file.path === RULE)!.text, /unrelated/);
  const none = JSON.parse(cli(root, "review", "Quota", "--files", "none", "--format", "json").stdout) as ReviewReport;
  assert.deepEqual(none.files, []);
  assert.deepEqual(none.excerpts, []);
  recordAdequate(root);
  editFile(root, RULE, (text) => text.replace("n > threshold", "n >= threshold"));
  assert.equal(staleBecause(root), `dependency ${RULE} changed`);
});

/** @tests Cli
 * @covers review-dependency-relevant review-dependency-isolated */
test("default imports and explicit re-exports follow helpers across files while local shadowing does not select an import", (t) => {
  const helper = "src/quota/limit.ts";
  const root = quotaProject(t, {
    [RULE]: 'export { default as hasQuota } from "./limit.ts";\n',
    [helper]: lines("const minimum = 0;", "export default function allows(left: number): boolean { return left > minimum; }", "export const unrelated = 123;"),
  });
  recordAdequate(root);
  editFile(root, helper, (text) => text.replace("unrelated = 123", "unrelated = 456"));
  assert.equal(staleBecause(root), undefined);
  editFile(root, helper, (text) => text.replace("minimum = 0", "minimum = 1"));
  assert.equal(staleBecause(root), `dependency ${helper} changed`);

  const shadow = quotaProject(t, { [RULE]: lines("export const hasQuota = (left: number): boolean => left > 0;", "export const noise = 123;") });
  editFile(shadow, IMPLEMENTATION, (text) => text.replace("{ hasQuota }", "{ hasQuota, noise }").replace("if (!hasQuota(this.left))", "const local = (noise: number) => noise;\n    if (!hasQuota(local(this.left)))"));
  recordAdequate(shadow);
  editFile(shadow, RULE, (text) => text.replace("noise = 123", "noise = 456"));
  assert.equal(staleBecause(shadow), undefined);
});

/** @tests Cli
 * @covers review-dependency-relevant */
test("import retargeting changes root material even when both targets are already selected, including setup", (t) => {
  const root = quotaProject(t, { [RULE]: "export const hasQuota = (left: number): boolean => left > 0;\nexport const alternate = (left: number): boolean => left > 1;\n" });
  editFile(root, IMPLEMENTATION, (text) => text.replace("{ hasQuota }", "{ hasQuota, alternate }").replace("if (!hasQuota(this.left))", "if (!hasQuota(this.left) || !alternate(this.left))"));
  editFile(root, TESTS, (text) => `import { hasQuota, alternate } from "./quota-rule.ts";\n${text}`.replace("quota = fresh(MemoryQuota);", "quota = fresh(MemoryQuota);\n    hasQuota(2); alternate(2);"));
  recordAdequate(root);
  editFile(root, IMPLEMENTATION, (text) => text.replace("{ hasQuota, alternate }", "{ alternate as hasQuota, hasQuota as alternate }"));
  assert.equal(staleBecause(root), `implementation MemoryQuota (${IMPLEMENTATION}) changed`);
  recordAdequate(root);
  editFile(root, TESTS, (text) => text.replace("{ hasQuota, alternate }", "{ alternate as hasQuota, hasQuota as alternate }"));
  assert.match(staleBecause(root)!, /test "refuses when empty"/);
  assert.match(staleBecause(root)!, /test "takes one send"/);
});

/** @tests Cli
 * @covers review-dependency-fallback */
test("adding initialization effects invalidates a slice and subsequent unrelated edits invalidate the whole file", (t) => {
  const root = quotaProject(t, { [RULE]: "export const hasQuota = (left: number): boolean => left > 0;\nexport const unrelated = 123;\n" });
  recordAdequate(root);
  editFile(root, RULE, (text) => `${text}console.log("initializing");\n`);
  assert.equal(staleBecause(root), `dependency ${RULE} changed`);
  recordAdequate(root);
  editFile(root, RULE, (text) => text.replace("unrelated = 123", "unrelated = 456"));
  assert.equal(staleBecause(root), `dependency ${RULE} changed`);
});

/** @tests Cli
 * @covers review-dependency-fallback */
test("unused value imports still carry initialization effects and fallback follows their dependencies", (t) => {
  const effects = "src/quota/effects.ts";
  const root = quotaProject(t, {
    [RULE]: 'import { unused } from "./effects.ts";\nexport const hasQuota = (left: number): boolean => left > 0;\nexport const unrelated = 123;\n',
    [effects]: 'export const unused = 0;\nconsole.log("initializing");\n',
  });
  recordAdequate(root);
  editFile(root, RULE, (text) => text.replace("unrelated = 123", "unrelated = 456"));
  assert.equal(staleBecause(root), `dependency ${RULE} changed`);
  recordAdequate(root);
  editFile(root, effects, (text) => text.replace("initializing", "changed"));
  assert.equal(staleBecause(root), `dependency ${effects} changed`);
});

/** @tests Cli
 * @covers review-dependency-relevant review-stale */
test("module-level test setup keeps imported helpers even when the linked test never names them", (t) => {
  const setup = "src/quota/setup.ts";
  const root = quotaProject(t, { [setup]: "export function configure(): void { console.log('setup'); }\nexport const unrelated = 123;\n" });
  editFile(root, TESTS, (text) => `import { configure } from "./setup.ts";\nconfigure();\n${text}`);
  recordAdequate(root);
  editFile(root, setup, (text) => text.replace("'setup'", "'changed'"));
  assert.equal(staleBecause(root), `dependency ${setup} changed`);
  recordAdequate(root);
  editFile(root, setup, (text) => text.replace("unrelated = 123", "unrelated = 456"));
  assert.equal(staleBecause(root), undefined);
});

/** @tests Cli
 * @covers review-dependency-relevant review-dependency-isolated */
test("multiple imports union their declarations, while type-only re-exports contribute no dependency", (t) => {
  const leaf = "src/quota/leaf.ts";
  const root = quotaProject(t, {
    [RULE]: 'import { first } from "./leaf.ts";\nexport { type Shape } from "./types.ts";\nexport const hasQuota = (left: number): boolean => left > first;\n',
    [STUB]: 'import { second } from "./leaf.ts";\nexport const fresh = <T>(Kind: new () => T): T => { second(); return new Kind(); };\n',
    [leaf]: "export const first = 0;\nexport const second = () => 1;\nexport const unrelated = 123;\n",
    "src/quota/types.ts": "export type Left = number; export interface Shape { value: number; }\n",
  });
  recordAdequate(root);
  assert.deepEqual(packet(root).contracts[0].fingerprinted, [RULE, STUB, leaf]);
  editFile(root, leaf, (text) => text.replace("unrelated = 123", "unrelated = 456"));
  assert.equal(staleBecause(root), undefined);
  editFile(root, leaf, (text) => text.replace("second = () => 1", "second = () => 2"));
  assert.equal(staleBecause(root), `dependency ${leaf} changed`);
  recordAdequate(root);
  editFile(root, leaf, (text) => text.replace("first = 0", "first = 1"));
  assert.equal(staleBecause(root), `dependency ${leaf} changed`);
});

test("whole-file records remain readable and become stale without rewriting or renewing their verdict", (t) => {
  const root = quotaProject(t, { [RULE]: "export const hasQuota = (left: number): boolean => left > 0;\nexport const unrelated = 123;\n" });
  recordAdequate(root);
  const recordPath = path.join(root, ".cage/review.json");
  const record = JSON.parse(fs.readFileSync(recordPath, "utf8")) as { version: 1; reviews: ReviewEntry[] };
  const entry = record.reviews[0];
  const result = checkLinking(root);
  const material = collectMaterial(result, "Quota", createFileReader(root, [], result.linking.sources).read);
  entry.material = fingerprintOf(material.parts, "sha256:legacy").digests;
  // Model a v1 record whose dependency part was the whole file, as older releases wrote it.
  entry.material[`dependency ${RULE}`] = `sha256:${crypto.createHash("sha256").update(fs.readFileSync(path.join(root, RULE))).digest("hex")}`;
  const hash = crypto.createHash("sha256");
  for (const [key, digest] of Object.entries(entry.material)) hash.update(`${key}\n${digest}\0`);
  entry.fingerprint = `sha256:${hash.digest("hex")}`;
  fs.writeFileSync(recordPath, JSON.stringify(record));
  const before = fs.readFileSync(recordPath, "utf8");
  assert.equal(staleBecause(root), `dependency ${RULE} changed`);
  assert.ok(!check(root).report.diagnostics.some(({ code }) => code === "E_CONFIG"));
  assert.equal(fs.readFileSync(recordPath, "utf8"), before);
});

test("dependency snapshots are shared by collection and excerpts even when files change between contracts", (t) => {
  const root = quotaProject(t);
  const result = checkLinking(root);
  const diagnostics: Diagnostic[] = [];
  const reader = createFileReader(root, diagnostics, result.linking.sources);
  const first = collectMaterial(result, "Quota", reader.read);
  editFile(root, RULE, () => "export const hasQuota = () => false;\n");
  const second = collectMaterial(result, "Quota", reader.read);
  assert.deepEqual(second.parts, first.parts);
  assert.match(reader.files.get(RULE)!.text, /left > 0/);
  assert.deepEqual(diagnostics, []);
});

// The same bounded binding/proof engine must work with both supported Compiler APIs. These cases
// complement the CLI mutations above with syntaxes a project might use even in broken source.
/** @tests Cli
 * @covers review-dependency-fallback review-dependency-relevant review-dependency-isolated */
test("dependency slicing syntax and conservative boundaries under TypeScript 5.9 and 6", () => {
  // AST objects never cross versions: each case creates and reads nodes with the same runtime.
  for (const compiler of [ts, ts5 as unknown as typeof ts]) {
    const slice = (dependency: string, extra: Record<string, string> = {}, root = 'import { used } from "dep";\nexport const run = () => used;') => {
      const sources = new Map(Object.entries({ root, dep: dependency, ...extra }).map(([file, text]) => [`${file}.ts`, compiler.createSourceFile(`${file}.ts`, text, compiler.ScriptTarget.Latest, true, compiler.ScriptKind.TS)]));
      const result = dependencySlices(compiler, sources, [{ file: "root.ts", nodes: [sources.get("root.ts")!.statements[1]] }], ["dep.ts", ...Object.keys(extra).map((file) => `${file}.ts`)], new Set(), (specifier) => `${specifier}.ts`).dependencies;
      return new Map([...result].map(([file, slice]) => [file.slice(0, -3), slice]));
    };
    const base = "export const used = 1;\nexport const unused = 123;\n";
    assert.doesNotMatch(slice(base).get("dep")!.text, /unused/);
    for (const unsupported of [
      "export let mutable = 1;", "export class Unused {}", "const x = new Date();", "console.log('effect');",
      "const x = { get value() { return 1; } };", "const x = { ...used };", "const x = { [used]: 1 };",
      'import * as ns from "leaf";', 'export * from "leaf";', 'import "leaf";', 'import x = require("leaf");',
      'import { x } from "absent";', "const x = unknown;", "const a = b; const b = a;",
    ]) assert.equal(slice(base + unsupported, { leaf: "export const x = 1;" }).get("dep"), undefined, unsupported);
    assert.equal(slice(base + 'import { x } from "leaf";', { leaf: 'import { used } from "dep"; export const x = 1;' }).get("dep"), undefined, "import cycle");
    const defaults = slice('const n = 0; export default function used() { return n; } export const unused = 123;', {}, 'import used from "dep";\nexport const run = () => used;');
    assert.match(defaults.get("dep")!.text, /const n = 0/);
    assert.doesNotMatch(defaults.get("dep")!.text, /unused/);
    const alias = slice('const local = 1; export { local as used }; export const unused = 123;');
    assert.match(alias.get("dep")!.text, /const local = 1/);
    assert.doesNotMatch(alias.get("dep")!.text, /unused/);
    const constants = slice('import { n } from "leaf"; export const used = n; export const unused = 123;', { leaf: "export const n = 1; export const unrelated = 999;" });
    assert.match(constants.get("leaf")!.text, /const n = 1/);
    assert.doesNotMatch(constants.get("leaf")!.text, /unrelated/);
    assert.equal(slice("export function used() { return eval('unused'); } const unused = 1;").get("dep"), undefined, "dynamic lexical access");
    assert.equal(slice("export function used() { return (eval)('unused'); } const unused = 1;").get("dep"), undefined, "parenthesized eval");
    assert.equal(slice(base, {}, 'import * as ns from "dep";\nexport const run = () => ns.used;').get("dep"), undefined, "namespace demand makes a pure target whole");
    assert.equal(slice(base, {}, 'import dep = require("dep");\nexport const run = () => dep.used;').get("dep"), undefined, "CommonJS demand makes a pure target whole");
    assert.equal(slice(base, {}, 'import "dep";\nexport const run = () => 1;').get("dep"), undefined, "side-effect-only demand keeps the whole file");
    assert.equal(slice('export { used } from "leaf";', { leaf: "export const used = 1; export class SideEffect {}" }).get("leaf"), undefined, "fallback at a re-export target");
    for (const extension of ["js", "mjs", "cjs", "tsx"]) {
      const dependency = `dep.${extension}`;
      const sources = new Map([
        ["root.ts", compiler.createSourceFile("root.ts", 'import { used } from "dep"; export const run = () => used();', compiler.ScriptTarget.Latest, true)],
        [dependency, compiler.createSourceFile(dependency, "const helper = () => 1; export const used = () => helper(); export const unused = 123;", compiler.ScriptTarget.Latest, true)],
      ]);
      const result = dependencySlices(compiler, sources, [{ file: "root.ts", nodes: [sources.get("root.ts")!.statements[1]] }], [dependency], new Set(), () => dependency).dependencies.get(dependency)!;
      assert.match(result.text, /const helper = \(\) => 1/, extension);
      assert.doesNotMatch(result.text, /unused/, extension);
    }
  }
});

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

/** @tests Cli
 * @covers review-stale */
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

/** @tests Cli
 * @covers review-stale */
test("a stub the tests import, and the setup of their suite, are part of what the tests observe", (t) => {
  const root = quotaProject(t);
  recordAdequate(root);
  editFile(root, STUB, () => "export const fresh = <T>(Kind: new () => T): T => Object.assign(new Kind() as object, { left: 99 }) as T;\n");
  assert.equal(staleBecause(root), `dependency ${STUB} changed`);
  recordAdequate(root);
  // The suite's beforeEach belongs to both tests.
  editFile(root, TESTS, (text) => text.replace("quota = fresh(MemoryQuota);", "quota = new MemoryQuota();"));
  // The unused pure stub now has an empty slice: the dependency material changes along with setup.
  assert.equal(staleBecause(root), `test "refuses when empty" (${TESTS}) changed, test "takes one send" (${TESTS}) changed, dependency ${STUB} changed`);
  assert.ok(!packet(root).excerpts.some((excerpt) => excerpt.file === STUB), "an empty slice has no source ranges to print");
});

/** @tests Cli
 * @covers review-stale */
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
    check(root).report.diagnostics.filter((diagnostic) => diagnostic.code === "E_REVIEW_STALE").map((diagnostic) => [diagnostic.contract, /\n- (.*)$/.exec(diagnostic.message)?.[1]]),
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

/** @tests Cli
 * @covers review-scope-silent */
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
  assert.match(warned.message, /^Quota, 3 dependency files fingerprinted\n- src\/quota\/b\.ts \(past the depth\)$/);
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
    assert.match(stdout, /^E_CONFIG: "reviewDependencies" must be an object with "depth" \(0–10\), "maxFiles" \(0–1000\) and "exclude" .* \(\.cage\/config\.json\)$/m);
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
