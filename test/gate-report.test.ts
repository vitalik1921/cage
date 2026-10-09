import assert from "node:assert/strict";
import { test } from "node:test";
import type { Diagnostic } from "../src/diagnostic.ts";
import type { CheckReport } from "../src/check.ts";
import { formatGateReport } from "../src/gate-report.ts";

function report(diagnostics: Diagnostic[]): CheckReport {
  return {
    schemaVersion: 1, command: "check", phase: "implementation", ok: false,
    scope: { tsconfig: "tsconfig.json", designFiles: [], typescript: { version: "6.0.3", source: "project" }, compilerOptions: null, lockBase: null },
    counts: {
      contracts: null, data: null, invariants: null, implementations: null, testDeclarations: null,
      linkedInvariants: null, activeTestDeclarations: null, activeInvariants: null, uncheckedInvariants: null,
      executedTests: null, reviewedInvariants: null, weakInvariants: null, weakContracts: null,
      acceptedContracts: null, acceptedInvariants: null,
    },
    invariants: null, index: null, omitted: { limit: null, count: 0, errors: 0, warnings: 0, byCode: {} }, diagnostics,
  };
}

test("gate groups every changed test even beyond check's ten-item preview, and distinguishes additions and removals", () => {
  const output = formatGateReport(report([{
    code: "E_REVIEW_STALE", severity: "error", contract: "Fill", message: "Fill\n- truncated preview",
    review: { changes: [
      ...Array.from({ length: 12 }, (_, n) => ({ part: `test src/fill.spec.ts:title ${n}`, change: "changed" as const })),
      { part: "test src/fill.spec.ts:added", change: "new" },
      { part: "test src/old.spec.ts:removed", change: "gone" },
      { part: "dependency src/config.ts", change: "changed" },
      { part: "contract", change: "changed" },
    ] },
  }]), "all");
  assert.match(output, /Changed: 12 tests in src\/fill.spec.ts/);
  assert.match(output, /Added: 1 test in src\/fill.spec.ts/);
  assert.match(output, /Removed: 1 test in src\/old.spec.ts/);
  assert.match(output, /Changed: 1 dependency in src\/config.ts/);
  assert.match(output, /1 more change groups/);
  assert.match(output, /cage review Fill/);
  assert.doesNotMatch(output, /truncated preview|title 11/);
});

test("weak feedback labels a literal excerpt, preserves assessment and points to full context without promoting suggestions", () => {
  const reason = 'Short passwords can be logged. ' + 'Evidence and qualifications follow. '.repeat(30);
  const output = formatGateReport(report([{
    code: "E_REVIEW_WEAK", severity: "error", contract: "SignIn", invariant: "secret",
    message: `SignIn.secret weak\n${reason}\nsuggested: Weaken the invariant.`,
    review: { finding: { assessment: "weak", reason } },
  }, {
    code: "E_REVIEW_WEAK", severity: "error", contract: "Read", message: "Read (the contract as a whole) insufficient-context",
    review: { finding: { assessment: "insufficient-context", reason: "Browser evidence is missing." } },
  }]), "all");
  assert.match(output, /^cage gate: blocked — 2 weak findings/);
  assert.match(output, /Recorded finding: Short passwords can be logged\./);
  assert.match(output, /… \[excerpt\]/);
  assert.match(output, /fix the implementation or test as needed/);
  assert.match(output, /cage review SignIn --files context/);
  assert.match(output, /provide the missing evidence/);
  assert.doesNotMatch(output, /Weaken the invariant/);
  assert.ok(output.length < reason.length + 1000);
});

test("hidden blockers are counted, removed contracts get no invalid command, and released feedback never says blocked", () => {
  const input = report([
    { code: "E_REVIEW_STALE", severity: "error", message: "Deleted (src/old) is not in the designs", file: ".cage/review.json" },
    { code: "E_TYPESCRIPT", severity: "error", message: "Type mismatch\nExpected number", file: "src/a.ts", line: 4, column: 2, tsCode: 2322, related: [{ message: "Declared here", file: "src/b.ts", line: 1, column: 1 }] },
  ]);
  const hidden = formatGateReport(input, 0);
  assert.match(hidden, /1 outdated review, 1 other error/);
  assert.match(hidden, /2 more not shown/);
  assert.doesNotMatch(hidden, /E_TYPESCRIPT: Type mismatch/);
  const released = formatGateReport(input, "all", true);
  assert.match(released, /^cage gate: unresolved/);
  assert.doesNotMatch(released, /blocked|cage review Deleted/);
  assert.match(released, /recording verdicts also removes obsolete records/);
  assert.match(released, /Expected number/);
  assert.match(released, /src\/a.ts:4:2, TS2322/);
  assert.match(released, /Declared here \(src\/b.ts:1:1\)/);
});

test("fingerprint-only changes and accepted records are not described as code changes", () => {
  const output = formatGateReport(report([{
    code: "E_REVIEW_STALE", severity: "error", contract: "$Fill", message: "$Fill (accepted without a review): no part differs, the fingerprint does", review: { changes: [] },
  }]), "all");
  assert.match(output, /accepted without a review/);
  assert.match(output, /fingerprint changed without a differing material part/);
  assert.match(output, /cage review '\$Fill'/);
  assert.doesNotMatch(output, /Changed: /);
});
