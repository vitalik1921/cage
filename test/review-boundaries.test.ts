import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { CheckReport } from "../src/check.ts";
import type { ReviewReport } from "../src/review.ts";
import { REVIEW_FILE, VERDICTS_SCHEMA, type Finding, type RecordReport } from "../src/review-record.ts";
import { checkLinking, cli, contract, copyFixture, designProject, mdx, scratchDirectory, VITEST, writeFile } from "./helpers.ts";

const QUOTA_DIR = "src/modules/quota";
const QUOTA_TEST = `${QUOTA_DIR}/quota.test.ts`;
const QUOTA_IMPL = `${QUOTA_DIR}/memory-quota.ts`;
const SENTINEL = "SENTINEL-OUTSIDE-7731";
const QUOTA_INVARIANTS = ["accounts", "empty", "consume", "race"];

const packetJson = (root: string, ...args: string[]) => cli(root, "review", "Quota", "--format", "json", ...args);
const fingerprint = (root: string) => (JSON.parse(packetJson(root).stdout) as ReviewReport).contracts[0].fingerprint;
const finding = (invariant: string | null, extra: Partial<Finding> = {}): Finding => ({ invariant, assessment: "adequate", reason: "Read the test.", evidence: `${QUOTA_TEST}:9`, suggestedChange: null, ...extra });
function record(root: string, findings: Finding[], fingerprintOf = fingerprint(root)) {
  writeFile(root, "verdicts.json", JSON.stringify({ version: 1, verdicts: [{ contract: "Quota", fingerprint: fingerprintOf, findings }] }));
  const run = cli(root, "review", "--record", "verdicts.json", "--format", "json");
  return { code: run.code, report: JSON.parse(run.stdout) as RecordReport };
}
const adequate = () => QUOTA_INVARIANTS.map((id) => finding(id));
const staleOf = (root: string) => (JSON.parse(cli(root, "check", "--format", "json").stdout) as CheckReport).diagnostics.filter(({ code, contract: name }) => code.endsWith("REVIEW_STALE") && name === "Quota").map(({ message }) => message);

// --- 2: a symbolic link out of the project is never read into a packet or a fingerprint ---

/** The plan fixture with a file outside the project and a link to it from the Quota module. */
function withOutsideLink(t: TestContext): { root: string; secret: string } {
  const root = copyFixture(t, "vertical");
  const outside = scratchDirectory(t, "outside");
  const secret = path.join(outside, "secret.ts");
  fs.writeFileSync(secret, `export const SECRET = "${SENTINEL}";\n`);
  fs.symlinkSync(secret, path.join(root, QUOTA_DIR, "linked.ts"));
  return { root, secret };
}

for (const preserveSymlinks of [false, true]) {
  test(`a file reached through a link out of the project is not read: no packet, fingerprint or record holds its content${preserveSymlinks ? " (preserveSymlinks)" : ""}`, (t) => {
    if (process.platform === "win32") return t.skip("symbolic links need privileges");
    outsideLink(t, preserveSymlinks);
  });
}

function outsideLink(t: TestContext, preserveSymlinks: boolean): void {
  const { root, secret } = withOutsideLink(t);
  // A helper the tests import, and a dependency of the implementation: both through the link. The compiler resolves
  // a relative import to the path it is written as, inside the project; only the real path shows where the file is.
  fs.writeFileSync(path.join(root, QUOTA_TEST), fs.readFileSync(path.join(root, QUOTA_TEST), "utf8").replace('import { MemoryQuota } from "./memory-quota.ts";', 'import { MemoryQuota } from "./memory-quota.ts";\nimport { SECRET } from "./linked.ts";\nvoid SECRET;'));
  fs.writeFileSync(path.join(root, QUOTA_IMPL), `import { SECRET } from "./linked.ts";\nvoid SECRET;\n${fs.readFileSync(path.join(root, QUOTA_IMPL), "utf8")}`);
  if (preserveSymlinks) {
    const tsconfig = JSON.parse(fs.readFileSync(path.join(root, "tsconfig.json"), "utf8"));
    writeFile(root, "tsconfig.json", JSON.stringify({ ...tsconfig, compilerOptions: { ...tsconfig.compilerOptions, preserveSymlinks: true } }));
  }

  const json = packetJson(root);
  const markdown = cli(root, "review", "Quota");
  for (const output of [json.stdout, json.stderr, markdown.stdout, markdown.stderr]) assert.ok(!output.includes(SENTINEL));
  // The outside file cannot even be opened now: had cage tried to read it, it would say so.
  if (process.getuid?.() !== 0) {
    fs.chmodSync(secret, 0o000);
    const unreadable = JSON.parse(packetJson(root).stdout) as ReviewReport;
    assert.ok(!unreadable.contracts[0].diagnostics.some(({ code }) => code === "E_ENVIRONMENT"), JSON.stringify(unreadable.contracts[0].diagnostics));
    fs.chmodSync(secret, 0o644);
  }
  const report = JSON.parse(json.stdout) as ReviewReport;
  const [packet] = report.contracts;
  assert.ok(!report.files.some((file) => file.path.endsWith("linked.ts")));
  assert.ok(!packet.helpers.includes(`${QUOTA_DIR}/linked.ts`));
  assert.ok(!packet.fingerprinted.includes(`${QUOTA_DIR}/linked.ts`));
  assert.ok(!packet.diagnostics.some(({ code }) => code === "E_ENVIRONMENT"), JSON.stringify(packet.diagnostics));
  // Said, not silent: the helper at the packet, the dependency at the bounds of the fingerprint.
  assert.ok(packet.diagnostics.some(({ code, file, message }) => code === "W_OUTSIDE_ROOT" && file === `${QUOTA_DIR}/linked.ts` && /outside the project/.test(message)), JSON.stringify(packet.diagnostics));
  assert.ok(packet.diagnostics.some(({ code, message }) => code === "W_REVIEW_SCOPE_LIMIT" && message.includes(`${QUOTA_DIR}/linked.ts (a link out of the project)`)), JSON.stringify(packet.diagnostics));

  const recorded = record(root, adequate(), packet.fingerprint);
  assert.equal(recorded.code, 0, JSON.stringify(recorded.report.diagnostics));
  assert.ok(!fs.readFileSync(path.join(root, REVIEW_FILE), "utf8").includes(SENTINEL));
  assert.ok(!Object.keys(JSON.parse(fs.readFileSync(path.join(root, REVIEW_FILE), "utf8")).reviews.find((entry: { contract: string }) => entry.contract === "Quota").material).some((key) => key.includes("linked.ts")));
  // The hole stays: a verdict is recorded against what cage could read, and where reviews are required check
  // does not let the hole through, as for any part the fingerprint leaves out.
  writeFile(root, ".cage/config.json", JSON.stringify({ version: 1, review: "require" }));
  const required = JSON.parse(cli(root, "check", "--format", "json").stdout) as CheckReport;
  assert.ok(required.diagnostics.some(({ code, contract: name, message }) => code === "E_REVIEW_SCOPE_LIMIT" && name === "Quota" && message.includes("a link out of the project")));
  assert.equal(required.ok, false);
  assert.ok(!JSON.stringify(required).includes(SENTINEL));
}

test("a project opened through a link to it is read as usual: the boundary is the real root, not the spelling", (t) => {
  if (process.platform === "win32") return t.skip("symbolic links need privileges");
  const root = copyFixture(t, "vertical");
  const link = path.join(scratchDirectory(t, "link"), "project");
  fs.symlinkSync(root, link);
  const direct = JSON.parse(packetJson(root).stdout) as ReviewReport;
  const linked = JSON.parse(cli(link, "review", "Quota", "--format", "json").stdout) as ReviewReport;
  assert.deepEqual(linked.files.map(({ path: file }) => file), direct.files.map(({ path: file }) => file));
  assert.equal(linked.contracts[0].fingerprint, direct.contracts[0].fingerprint);
  assert.ok(!linked.contracts[0].diagnostics.some(({ code }) => code === "W_OUTSIDE_ROOT"));
});

// --- 3: what an ordinary block or a loop declares around a test is part of the test ---

test("the variables of a block or a loop around a test, and the loop's header, are in its fingerprint", (t) => {
  const root = copyFixture(t, "vertical");
  writeFile(
    root,
    QUOTA_TEST,
    [
      'import assert from "node:assert/strict";',
      'import { describe, it } from "node:test";',
      'import { MemoryQuota } from "./memory-quota.ts";',
      "",
      "/** @tests Quota */",
      'describe("MemoryQuota", () => {',
      "  for (const left of [0]) {",
      "    const unknown = \"nobody\";",
      "    /** @covers empty */",
      '    it("refuses", async () => {',
      "      const quota = new MemoryQuota({ a: left });",
      "      assert.equal(await quota.take(\"a\"), false);",
      "      assert.equal(await quota.take(unknown), false);",
      "    });",
      "  }",
      "  {",
      "    const start = 1;",
      "    const expected = false;",
      "    /** @covers consume accounts race */",
      '    it("takes one", async () => {',
      "      const quota = new MemoryQuota({ a: start, b: 1 });",
      "      assert.equal(await quota.take(\"a\"), true);",
      "      assert.equal(await quota.take(\"a\"), expected);",
      "    });",
      "  }",
      "});",
      "",
    ].join("\n"),
  );
  assert.equal(record(root, adequate()).code, 0);
  assert.deepEqual(staleOf(root), []);
  const edit = (from: string, to: string) => writeFile(root, QUOTA_TEST, fs.readFileSync(path.join(root, QUOTA_TEST), "utf8").replace(from, to));

  const changed = (title: string) => new RegExp(`since then: test "${title}" \\(src/modules/quota/quota\\.test\\.ts\\) changed\\.`);
  edit("for (const left of [0])", "for (const left of [1])");
  assert.match(staleOf(root)[0] ?? "", changed("refuses"));
  assert.equal(record(root, adequate()).code, 0);

  edit('const unknown = "nobody";', 'const unknown = "a";');
  assert.match(staleOf(root)[0] ?? "", changed("refuses"));
  assert.equal(record(root, adequate()).code, 0);

  edit("const start = 1;", "const start = 2;");
  assert.match(staleOf(root)[0] ?? "", changed("takes one"));
  assert.equal(record(root, adequate()).code, 0);

  // The source review's case: the expected value of an assertion, inverted in the block around the test.
  const before = fingerprint(root);
  edit("const expected = false;", "const expected = true;");
  assert.notEqual(fingerprint(root), before);
  assert.match(staleOf(root)[0] ?? "", changed("takes one"));
});

// --- 4: a dependency that cannot be read stops the packet and the record, never silently ---

/**
 * The layout of the review of 2026-10-05: the Quota test imports a readable helper outside `src`, which imports a
 * second one; `layout` "excluded" keeps the second out of the program instead, as a file of another tool would be.
 */
for (const layout of ["test-support", "excluded"] as const) {
  test(`a dependency the review cannot read makes the packet incomplete and the record refuse, leaving the review file as it was (${layout})`, (t) => {
    if (process.platform === "win32" || process.getuid?.() === 0) return t.skip("file permissions do not apply");
    const root = copyFixture(t, "vertical");
    const [first, second, specifier] =
      layout === "test-support" ? ["test-support/a.ts", "test-support/b.ts", "../../../test-support/a.ts"] : [`${QUOTA_DIR}/quota-fixture.ts`, `${QUOTA_DIR}/deep.ts`, "./quota-fixture.ts"];
    writeFile(root, first, 'import { seed } from "./' + path.posix.basename(second) + '";\nexport const initial = () => ({ a: seed });\n');
    writeFile(root, second, "export const seed = 1;\n");
    writeFile(root, QUOTA_TEST, fs.readFileSync(path.join(root, QUOTA_TEST), "utf8").replace('import { MemoryQuota } from "./memory-quota.ts";', `import { MemoryQuota } from "./memory-quota.ts";\nimport { initial } from "${specifier}";\nvoid initial;`));
    if (layout === "excluded") writeFile(root, "tsconfig.json", JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(root, "tsconfig.json"), "utf8")), exclude: [second] }));
    const before = JSON.parse(packetJson(root).stdout) as ReviewReport;
    assert.deepEqual(before.contracts[0].fingerprinted, [first, second]);
    assert.equal(record(root, adequate(), before.contracts[0].fingerprint).code, 0);
    const reviewFile = fs.readFileSync(path.join(root, REVIEW_FILE));

    fs.chmodSync(path.join(root, second), 0o000);
    const json = packetJson(root);
    const report = JSON.parse(json.stdout) as ReviewReport;
    assert.equal(json.code, 2);
    assert.equal(report.complete, false);
    const environment = report.contracts[0].diagnostics.filter(({ code }) => code === "E_ENVIRONMENT");
    assert.deepEqual(environment.map(({ file, contract: name }) => ({ file, contract: name })), [{ file: second, contract: "Quota" }], JSON.stringify(report.contracts[0].diagnostics));
    // Named from the project, not by this machine's path.
    assert.ok(!environment[0].message.includes(root), environment[0].message);
    assert.ok(report.diagnostics.some(({ code, file }) => code === "E_ENVIRONMENT" && file === second));
    assert.match(cli(root, "review", "Quota").stdout, /- ✗ Structural check: 1 error/);

    const refused = record(root, adequate(), report.contracts[0].fingerprint);
    assert.equal(refused.code, 2);
    assert.equal(refused.report.ok, false);
    assert.deepEqual(refused.report.recorded, []);
    assert.ok(refused.report.diagnostics.some(({ code, file }) => code === "E_ENVIRONMENT" && file === second));
    assert.deepEqual(fs.readFileSync(path.join(root, REVIEW_FILE)), reviewFile);
  });
}

// --- 5: a verdict says why and on what, or it is not recorded ---

test("a finding without a reason, or without evidence where its assessment needs some, is refused with the whole verdict", (t) => {
  const root = copyFixture(t, "vertical");
  assert.equal(record(root, adequate()).code, 0);
  const reviewFile = fs.readFileSync(path.join(root, REVIEW_FILE));
  const cases: [string, Finding[], RegExp][] = [
    ["blank reason", [finding("accounts", { reason: "   " }), ...adequate().slice(1)], /without a reason: `accounts`/],
    ["empty reason", [...adequate().slice(0, 3), finding("race", { assessment: "weak", reason: "" })], /without a reason: `race`/],
    ["null evidence on adequate", [finding("accounts", { evidence: null }), ...adequate().slice(1)], /without evidence: `accounts`/],
    ["blank evidence on weak", [finding("accounts", { assessment: "weak", evidence: " " }), ...adequate().slice(1)], /without evidence: `accounts`/],
    ["blank evidence on insufficient-context", [finding("accounts", { assessment: "insufficient-context", evidence: "" }), ...adequate().slice(1)], /without evidence: `accounts`/],
    ["contract-level note without evidence", [...adequate(), finding(null, { evidence: null })], /without evidence: the contract as a whole/],
    ["contract-level note without a reason", [...adequate(), finding(null, { assessment: "weak", reason: "\n" })], /without a reason: the contract as a whole/],
  ];
  for (const [name, findings, message] of cases) {
    const { code, report } = record(root, findings);
    assert.equal(code, 1, name);
    assert.deepEqual(report.diagnostics.map(({ code: diagnostic }) => diagnostic), ["E_REVIEW_VERDICT"], name);
    assert.match(report.diagnostics[0].message, message, name);
    assert.deepEqual(fs.readFileSync(path.join(root, REVIEW_FILE)), reviewFile, name);
  }
  // Insufficient context may have no evidence: that is what it says.
  assert.equal(record(root, [finding("accounts", { assessment: "insufficient-context", evidence: null }), ...adequate().slice(1)]).code, 0);
  // The schema the packet hands to a reviewer says the same.
  const item = VERDICTS_SCHEMA.properties.verdicts.items.properties.findings.items;
  assert.deepEqual(item.properties.reason, { type: "string", pattern: "\\S" });
  assert.deepEqual(item.properties.evidence, { type: ["string", "null"], pattern: "\\S" });
  assert.deepEqual(item.if, { properties: { assessment: { not: { const: "insufficient-context" } } } });
  assert.deepEqual(item.then, { properties: { evidence: { type: "string" } } });
});

// --- 6: a value import of what a module exports only as a type ---

const TYPES = "src/m/types.ts";
const QUOTA_CONTRACT = contract("Quota", "take(): boolean;", "@invariant empty Порожня квота відмовляє.");
function typesProject(t: TestContext, imports: string, body: string, options: { vitest?: boolean; compilerOptions?: object } = {}): string {
  const runner = options.vitest ? 'import { describe, it } from "vitest";' : 'import { describe, it } from "node:test";';
  const root = designProject(t, { m: mdx(QUOTA_CONTRACT) }, {
    "src/m/quota.ts": "/** @implements Quota */\nexport const quota = { take: () => true };\n",
    [TYPES]: [
      "export interface Shape { size: number }",
      "export class Klass { size = 1 }",
      "export type { Klass as TypeOnlyKlass };",
      "export { type Shape as AlsoShape };",
      "export type Count = number;",
      "export const value = 1;",
      "",
    ].join("\n"),
    "src/m/barrel.ts": 'export { Shape as Reexported, Klass as ReexportedKlass } from "./types.ts";\nexport type { Klass as TypeOnlyReexport } from "./types.ts";\nexport * from "./types.ts";\n',
    "src/m/cjs.cts": "class Legacy {}\nexport = Legacy;\n",
    // `export type *` re-exports names as types only, values included; a value star over it does not bring them back.
    "src/m/typestar.ts": 'export type * from "./types.ts";\n',
    "src/m/typestar-ns.ts": 'export type * as T from "./types.ts";\n',
    "src/m/valuestar.ts": 'export * from "./typestar.ts";\n',
    "src/m/named-from-typestar.ts": 'export { Klass } from "./typestar.ts";\n',
    "src/m/mixed-star.ts": 'export type * from "./types.ts";\nexport * from "./types.ts";\n',
    "src/m/quota.test.ts": [runner, imports, "", "/** @tests Quota */", 'describe("Quota", () => {', "  /** @covers empty */", `  it("refuses", () => { ${body} });`, "});", ""].join("\n"),
    ...(options.vitest ? VITEST : {}),
  });
  if (options.compilerOptions) {
    const tsconfig = JSON.parse(fs.readFileSync(path.join(root, "tsconfig.json"), "utf8"));
    writeFile(root, "tsconfig.json", JSON.stringify({ ...tsconfig, compilerOptions: { ...tsconfig.compilerOptions, ...options.compilerOptions } }));
  }
  return root;
}
const statusIn = (root: string, adapter: "node:test" | "vitest" = "node:test") => {
  const [declaration] = checkLinking(root, adapter).linking.tests;
  return { status: declaration.status, because: declaration.inactiveBecause };
};

test("node:test: a value import of a name that has no value at run time is broken, through aliases and re-exports", (t) => {
  for (const [imports, name] of [
    ['import { Shape } from "./types.ts";', "Shape"],
    ['import { Count } from "./types.ts";', "Count"],
    ['import { TypeOnlyKlass } from "./types.ts";', "TypeOnlyKlass"],
    ['import { AlsoShape } from "./types.ts";', "AlsoShape"],
    ['import { Reexported } from "./barrel.ts";', "Reexported"],
    ['import { TypeOnlyReexport } from "./barrel.ts";', "TypeOnlyReexport"],
    ['import { Shape, value } from "./barrel.ts";', "Shape"],
    ['import { Klass } from "./typestar.ts";', "Klass"],
    ['import { value } from "./typestar.ts";', "value"],
    ['import { T } from "./typestar-ns.ts";', "T"],
    ['import { Klass } from "./valuestar.ts";', "Klass"],
    ['import { Klass } from "./named-from-typestar.ts";', "Klass"],
  ] as const) {
    const root = typesProject(t, imports, "void 0;");
    const { status, because } = statusIn(root);
    assert.equal(status, "broken-import", imports);
    assert.match(because ?? "", new RegExp(`exports "${name}" only as a type`), imports);
  }
});

test("explicit type-only imports, values reached through aliases, namespaces and CommonJS stay active", (t) => {
  for (const imports of [
    'import type { Shape } from "./types.ts";',
    'import { type Shape, value } from "./types.ts";',
    'import { Klass, value } from "./types.ts";',
    'import { ReexportedKlass } from "./barrel.ts";',
    'import { Klass as Renamed } from "./barrel.ts";',
    'import * as types from "./types.ts";',
    'import Legacy = require("./cjs.cts");',
    'import * as onlyTypes from "./typestar.ts";',
    'import { Klass, value } from "./mixed-star.ts";',
  ]) {
    const root = typesProject(t, imports, "void 0;");
    assert.deepEqual(statusIn(root), { status: "active", because: undefined }, imports);
  }
});

test("Vitest drops an import used only as a type; one used as a value, or kept by verbatimModuleSyntax, is broken", (t) => {
  assert.equal(statusIn(typesProject(t, 'import { Shape } from "./types.ts";', "const s: Shape = { size: 1 }; void s;", { vitest: true }), "vitest").status, "active");
  assert.equal(statusIn(typesProject(t, 'import { TypeOnlyKlass } from "./types.ts";', "void new TypeOnlyKlass();", { vitest: true }), "vitest").status, "broken-import");
  assert.equal(statusIn(typesProject(t, 'import { Shape } from "./types.ts";', "const s: Shape = { size: 1 }; void s;", { vitest: true, compilerOptions: { verbatimModuleSyntax: true, module: "ESNext", moduleResolution: "Bundler" } }), "vitest").status, "broken-import");
});

test("Vitest: a value use of a name passed on by a named alias re-export of a type is broken; a type use, a shadowing name and a real value are not", (t) => {
  // The acceptance review's case: `export { Shape as Reexported }`, the alias used as a value, default options.
  const broken = statusIn(typesProject(t, 'import { Reexported } from "./barrel.ts";', "void Reexported;", { vitest: true }), "vitest");
  assert.equal(broken.status, "broken-import");
  assert.match(broken.because ?? "", /exports "Reexported" only as a type/);
  for (const [imports, body] of [
    ['import { Reexported } from "./barrel.ts";', "const s: Reexported = { size: 1 }; void s;"],
    ['import { Reexported } from "./barrel.ts";', "const Reexported = 1; void Reexported; const s: Reexported | undefined = undefined; void s;"],
    ['import { Reexported } from "./barrel.ts";', "function inner(Reexported: number) { return Reexported; } void inner;"],
    ['import { Reexported } from "./barrel.ts";', "const o = { Reexported: 1 }; void o.Reexported; const s: Reexported = { size: 1 }; void s;"],
    ['import { ReexportedKlass } from "./barrel.ts";', "void new ReexportedKlass();"],
  ] as const) {
    assert.equal(statusIn(typesProject(t, imports, body, { vitest: true }), "vitest").status, "active", body);
  }
});
