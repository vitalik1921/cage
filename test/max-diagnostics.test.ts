import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { CheckReport } from "../src/check.ts";
import { type Diagnostic, isError } from "../src/diagnostic.ts";
import { cli, cliWithStdin, contract, designProject, mdx, writeFile } from "./helpers.ts";

/** Three modules, each with a contract of two invariants and one without any, and no code: errors and warnings of several codes. */
function noisyProject(t: TestContext): string {
  const designs: Record<string, string> = {};
  for (const module of ["a", "b", "c"]) {
    designs[module] = mdx(contract(`Service${module.toUpperCase()}`, "run(): void;", "@invariant one Does one thing.", "@invariant two Does another."), contract(`Port${module.toUpperCase()}`, "open(): void;"));
  }
  return designProject(t, designs);
}

function check(root: string, ...args: string[]): { code: number; report: CheckReport } {
  const { code, stdout, stderr } = cli(root, "check", "--format", "json", ...args);
  assert.equal(stderr, "");
  return { code, report: JSON.parse(stdout) };
}

/** What a reader who sees only part of the report needs first, decided here on its own: unusable, failing, blocking the gate, the rest. */
const rank = (diagnostic: Diagnostic) => (diagnostic.code === "E_CONFIG" || diagnostic.code === "E_ENVIRONMENT" ? 0 : isError(diagnostic) ? 1 : /REVIEW_(MISSING|STALE)$/.test(diagnostic.code) ? 2 : 3);
const key = ({ code, file, line, column }: Diagnostic) => `${code} ${file}:${line}:${column}`;

/** @tests Cli
 * @covers check-limit */
test("check shows at most maxDiagnostics, the ones that matter most, in the order of the report, and counts the rest by code", (t) => {
  const root = noisyProject(t);
  const full = check(root, "--max-diagnostics", "all");
  assert.equal(full.code, 1);
  assert.deepEqual(full.report.omitted, { limit: null, count: 0, errors: 0, warnings: 0, byCode: {} });
  // Per module: an implementation missing for each contract, a test missing for each invariant, a review missing for each contract, one contract without invariants.
  const codes = full.report.diagnostics.map(({ code }) => code);
  assert.equal(codes.filter((code) => code === "E_IMPLEMENTATION_MISSING").length, 6);
  assert.equal(codes.filter((code) => code === "E_TEST_MISSING").length, 6);
  assert.equal(codes.filter((code) => code === "W_REVIEW_MISSING").length, 6);
  assert.equal(codes.filter((code) => code === "W_NO_INVARIANTS").length, 3);
  assert.equal(full.report.diagnostics.length, 21);

  // The expected selection, computed here: by rank, then by the report's order; shown in the report's order.
  const all = full.report.diagnostics;
  const expectedShown = (limit: number) =>
    all
      .map((diagnostic, index) => ({ diagnostic, index }))
      .sort((a, b) => rank(a.diagnostic) - rank(b.diagnostic) || a.index - b.index)
      .slice(0, limit)
      .sort((a, b) => a.index - b.index)
      .map(({ diagnostic }) => key(diagnostic));

  const limited = check(root, "--max-diagnostics", "14");
  // The exit code and `ok` are of everything found.
  assert.equal(limited.code, 1);
  assert.equal(limited.report.ok, false);
  assert.deepEqual(limited.report.diagnostics.map(key), expectedShown(14));
  // 12 errors, then two of the six review warnings; left: four review warnings and the three without invariants.
  assert.ok(limited.report.diagnostics.every((diagnostic) => isError(diagnostic) || diagnostic.code === "W_REVIEW_MISSING"));
  assert.deepEqual(limited.report.omitted, { limit: 14, count: 7, errors: 0, warnings: 7, byCode: { W_REVIEW_MISSING: 4, W_NO_INVARIANTS: 3 } });
  assert.deepEqual(limited.report.counts, full.report.counts);

  const text = cli(root, "check", "--max-diagnostics", "14").stdout;
  const lines = text.trimEnd().split("\n");
  assert.equal(lines.filter((line) => /^[EW]_[A-Z_]+: /.test(line)).length, 14);
  assert.equal(lines.at(-2), "7 more not shown (4 W_REVIEW_MISSING, 3 W_NO_INVARIANTS); --max-diagnostics all shows every one");
  // The summary counts every diagnostic, shown or not.
  assert.match(lines.at(-1)!, /; 12 errors, 9 warnings\. TypeScript/);

  // Fewer than the errors: the first errors in the report's order, and the omitted line names errors too.
  const few = check(root, "--max-diagnostics", "5");
  assert.deepEqual(few.report.diagnostics.map(key), expectedShown(5));
  assert.equal(few.report.omitted.errors, 7);
  assert.deepEqual(few.report.omitted.byCode, { E_IMPLEMENTATION_MISSING: 4, W_REVIEW_MISSING: 6, E_TEST_MISSING: 3, W_NO_INVARIANTS: 3 });

  // Zero: the counts by code and the summary only, still exit 1.
  const none = cli(root, "check", "--max-diagnostics", "0");
  assert.equal(none.code, 1);
  assert.equal(none.stdout.split("\n").length, 3);
  assert.match(none.stdout, /^21 more not shown \(6 E_IMPLEMENTATION_MISSING, 6 E_TEST_MISSING, 6 W_REVIEW_MISSING, 3 W_NO_INVARIANTS\); --max-diagnostics all shows every one$/m);

  // The default is 50, from the configuration: everything here is shown.
  assert.deepEqual(check(root).report.omitted, { limit: 50, count: 0, errors: 0, warnings: 0, byCode: {} });
  assert.doesNotMatch(cli(root, "check").stdout, /more not shown/);
  writeFile(root, ".cage/config.json", JSON.stringify({ version: 1, maxDiagnostics: 3 }));
  assert.equal(check(root).report.omitted.limit, 3);
  assert.equal(check(root).report.diagnostics.length, 3);
  // The flag overrides the configuration.
  assert.equal(check(root, "--max-diagnostics", "all").report.diagnostics.length, 21);
  writeFile(root, ".cage/config.json", JSON.stringify({ version: 1, maxDiagnostics: "all" }));
  assert.deepEqual(check(root).report.omitted, { limit: null, count: 0, errors: 0, warnings: 0, byCode: {} });
});

/** @tests Cli
 * @covers check-limit */
test("the gate limits only blocking diagnostics and counts every blocker", (t) => {
  const root = noisyProject(t);
  writeFile(root, ".cage/config.json", JSON.stringify({ version: 1, maxDiagnostics: 2 }));
  const gate = (...args: string[]) => cliWithStdin(root, JSON.stringify({ session_id: "max-diagnostics-test" }), "gate", ...args);
  const blocked = gate();
  assert.equal(blocked.code, 2);
  assert.equal(blocked.stderr.split("\n").filter((line) => /^E_[A-Z_]+: /.test(line)).length, 2);
  // Codes by count, equal counts by name.
  assert.match(blocked.stderr, /^10 more not shown \(6 E_IMPLEMENTATION_MISSING, 4 E_TEST_MISSING\); --max-diagnostics all shows every one$/m);
  assert.doesNotMatch(blocked.stderr, /W_NO_INVARIANTS|W_REVIEW_MISSING/);
  assert.doesNotMatch(blocked.stderr, /^check:/m);
  assert.match(blocked.stderr, /^cage gate: blocked — 12 other errors/);
  const whole = gate("--max-diagnostics", "all");
  assert.equal(whole.code, 2);
  assert.doesNotMatch(whole.stderr, /more not shown/);
  assert.equal(whole.stderr.split("\n").filter((line) => /^[EW]_[A-Z_]+: /.test(line)).length, 12);
  assert.doesNotMatch(whole.stderr, /W_NO_INVARIANTS|W_REVIEW_MISSING/);
  const none = gate("--max-diagnostics", "0");
  assert.equal(none.code, 2);
  assert.match(none.stderr, /^12 more not shown \(6 E_IMPLEMENTATION_MISSING, 6 E_TEST_MISSING\); --max-diagnostics all shows every one$/m);
  assert.doesNotMatch(none.stderr, /W_NO_INVARIANTS|W_REVIEW_MISSING/);
});

test("--max-diagnostics and maxDiagnostics take a whole number or all, for check and gate only", (t) => {
  const root = noisyProject(t);
  for (const given of ["-1", "abc", "1.5", "", "10001"]) {
    const run = cli(root, "check", `--max-diagnostics=${given}`);
    assert.equal(run.code, 2, given);
    assert.match(run.stderr, /^cage: --max-diagnostics needs a whole number from 0 to 10000, or all; got /);
  }
  assert.match(cli(root, "lock", "--max-diagnostics", "3").stderr, /--max-diagnostics is an option of the check and gate commands\./);
  assert.match(cli(root, "review", "--max-diagnostics", "3").stderr, /--max-diagnostics is an option of the check and gate commands\./);
  writeFile(root, ".cage/config.json", JSON.stringify({ version: 1, maxDiagnostics: "some" }));
  const invalid = cli(root, "check");
  assert.equal(invalid.code, 2);
  assert.match(invalid.stdout, /"maxDiagnostics" must be a whole number from 0 to 10000, or "all"/);
});
