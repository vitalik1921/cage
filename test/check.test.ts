import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { CheckReport } from "../src/check.ts";
import { loadTypeScript } from "../src/typescript.ts";
import { CAMPAIGNS, cli, contract, copyFixture, data, designProject, editFile, find, inFixture, isError, MAIL, mdx, QUOTA, senderWarning, snapshot, summary, writeFile } from "./helpers.ts";

function check(root: string, ...args: string[]): { code: number; report: CheckReport } {
  const { code, stdout, stderr } = cli(root, "check", "--phase", "design", "--format", "json", ...args);
  assert.equal(stderr, "");
  return { code, report: JSON.parse(stdout) };
}

const repository = path.join(import.meta.dirname, "..");

/** Gives a project its own `typescript` package: the TypeScript 5 that the repository installs for these tests. */
function installTypeScript5(root: string): void {
  fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
  fs.symlinkSync(path.join(repository, "node_modules/typescript-5"), path.join(root, "node_modules/typescript"));
}

test("check --phase design reports the plan fixture: 3 contracts, 1 data type, 8 invariants, one warning", (t) => {
  const root = copyFixture(t, "vertical");
  const before = snapshot(root);

  const { code, report } = check(root);
  assert.equal(code, 0);
  assert.deepEqual(report, {
    schemaVersion: 1,
    command: "check",
    phase: "design",
    ok: true,
    scope: {
      tsconfig: "tsconfig.json",
      designFiles: [CAMPAIGNS, MAIL, QUOTA],
      typescript: { version: "6.0.3", source: "project" },
      compilerOptions: { strictNullChecks: true, strictFunctionTypes: true, noImplicitAny: true },
      lockBase: null,
    },
    counts: { contracts: 3, data: 1, invariants: 8, implementations: null, testDeclarations: null, linkedInvariants: null, reviewedInvariants: null, weakInvariants: null },
    invariants: [
      { contract: "Send", id: "quota", member: "run", linkedTestCount: null, review: null },
      { contract: "Send", id: "limit", member: "run", linkedTestCount: null, review: null },
      { contract: "Send", id: "quota-error", member: "run", linkedTestCount: null, review: null },
      { contract: "Send", id: "sender-error", member: "run", linkedTestCount: null, review: null },
      { contract: "Quota", id: "accounts", member: null, linkedTestCount: null, review: null },
      { contract: "Quota", id: "empty", member: "take", linkedTestCount: null, review: null },
      { contract: "Quota", id: "consume", member: "take", linkedTestCount: null, review: null },
      { contract: "Quota", id: "race", member: "take", linkedTestCount: null, review: null },
    ],
    index: {
      contracts: [
        {
          name: "Send",
          module: "src/modules/campaigns",
          description: "Виконує одну спробу відправлення за наявності квоти.",
          shape: "object",
          lock: null,
          members: [{ name: "run", description: "Отримує квоту та передає повідомлення відправнику.", location: inFixture(CAMPAIGNS, "run(") }],
          implementations: null,
          location: inFixture(CAMPAIGNS, "Send {"),
        },
        {
          name: "Sender",
          module: "src/modules/mail",
          description: "Порт передачі текстового повідомлення обраному транспорту.",
          shape: "object",
          lock: null,
          members: [{ name: "send", description: null, location: inFixture(MAIL, "send(") }],
          implementations: null,
          location: inFixture(MAIL, "Sender {"),
        },
        {
          name: "Quota",
          module: "src/modules/quota",
          description: "Обліковує доступні спроби окремо для кожного акаунта.",
          shape: "object",
          lock: null,
          members: [{ name: "take", description: "Намагається використати одну одиницю доступної квоти.", location: inFixture(QUOTA, "take(") }],
          implementations: null,
          location: inFixture(QUOTA, "Quota {"),
        },
      ],
      data: [{ name: "AccountId", module: "src/modules/quota", description: "Ідентифікатор акаунта для обліку квоти.", lock: null, location: inFixture(QUOTA, "AccountId =") }],
      edges: [
        { kind: "type-import", fromModule: "src/modules/campaigns", toModule: "src/modules/quota", location: inFixture(CAMPAIGNS, "import type") },
        { kind: "uses", from: "Send", to: "Quota", fromModule: "src/modules/campaigns", toModule: "src/modules/quota", location: inFixture(CAMPAIGNS, "@uses") },
        { kind: "uses", from: "Send", to: "Sender", fromModule: "src/modules/campaigns", toModule: "src/modules/mail", location: inFixture(CAMPAIGNS, "@uses") },
      ],
    },
    diagnostics: [
      {
        code: "W_NO_INVARIANTS",
        severity: "warning",
        message: 'Contract "Sender" has no `@invariant`: only its types can be checked.',
        ...inFixture(MAIL, "Sender {"),
        contract: "Sender",
      },
    ],
  });
  assert.deepEqual(snapshot(root), before);

  assert.equal(
    cli(root, "check", "--phase", "design").stdout,
    [
      senderWarning(),
      "check --phase design: 3 designs, 3 contracts, 1 data type, 8 invariants; 0 errors, 1 warning. TypeScript 6.0.3 (project).",
      "",
    ].join("\n"),
  );
});

test("errors are exit 1 and warnings exit 0; a diagnostic names its contract and invariant", (t) => {
  const root = copyFixture(t, "vertical");
  const original = inFixture(QUOTA, "@invariant empty");
  const duplicate = inFixture(QUOTA, "@invariant consume");
  editFile(root, QUOTA, (s) => s.replace("@invariant consume", "@invariant empty"));

  const { code, report } = check(root);
  assert.equal(code, 1);
  assert.equal(report.ok, false);
  assert.deepEqual(
    report.diagnostics.filter(isError).map(({ code, contract, invariant, line }) => ({ code, contract, invariant, line })),
    [{ code: "E_INVARIANT_DUPLICATE", contract: "Quota", invariant: "empty", line: duplicate.line }],
  );
  assert.equal(report.counts.invariants, 7);

  const text = cli(root, "check", "--phase", "design");
  assert.equal(text.code, 1);
  assert.ok(
    text.stdout.includes(
      `${QUOTA}:${duplicate.line}:${duplicate.column}: error E_INVARIANT_DUPLICATE: Invariant id "empty" is already used in contract "Quota".\n` +
        `  ${QUOTA}:${original.line}:${original.column}: The other invariant.\n`,
    ),
  );
  assert.match(text.stdout, /7 invariants; 1 error, 1 warning\./);
});

test("configuration and environment problems are exit 2, an empty scope exit 1", (t) => {
  const root = copyFixture(t, "vertical");
  const codes = (args: string[] = []) => {
    const { code, report } = check(root, ...args);
    return { code, ok: report.ok, diagnostics: report.diagnostics.map((diagnostic) => diagnostic.code), counts: report.counts, invariants: report.invariants };
  };
  // Nothing was indexed: the counts are unknown, which is not zero.
  const unknown = { counts: { contracts: null, data: null, invariants: null, implementations: null, testDeclarations: null, linkedInvariants: null, reviewedInvariants: null, weakInvariants: null }, invariants: null };

  assert.deepEqual(codes(["--config", "nope.json"]), { code: 2, ok: false, diagnostics: ["E_CONFIG"], ...unknown });
  writeFile(root, ".cage/config.json", '{ "version": 1, "tsconfig": "missing.json" }');
  assert.deepEqual(codes(), { code: 2, ok: false, diagnostics: ["E_ENVIRONMENT"], ...unknown });
  assert.match(cli(root, "check", "--phase", "design").stdout, /check --phase design: 3 designs, contracts not indexed; 1 error, 0 warnings\./);
  writeFile(root, ".cage/config.json", '{ "version": 1, "designs": ["lib/**/*.cage.mdx"] }');
  assert.deepEqual(codes(), { code: 1, ok: false, diagnostics: ["E_NO_DESIGNS"], ...unknown });
});

test("reports are deterministic", (t) => {
  const root = copyFixture(t, "vertical");
  editFile(root, MAIL, (s) => s.replace("send(text: string)", "send(text: Txt)"));
  const run = () => cli(root, "check", "--phase", "design", "--format", "json").stdout;
  assert.equal(run(), run());
});

test("the project's own TypeScript checks its designs", (t) => {
  // Without `types`, TypeScript 5 loads every @types package and TypeScript 6 loads none.
  const designs = { a: mdx(data("Bytes", "Buffer"), contract("Thing")) };

  // This project has no TypeScript of its own; the nearest one is the repository's TypeScript 6.
  const newer = check(designProject(t, designs));
  assert.deepEqual(newer.report.scope.typescript, { version: "6.0.3", source: "project" });
  assert.deepEqual(
    newer.report.diagnostics.filter(isError).map(({ code, tsCode }) => ({ code, tsCode })),
    [{ code: "E_TYPESCRIPT", tsCode: 2591 }],
  );

  const root = designProject(t, designs);
  installTypeScript5(root);
  const own = check(root);
  assert.deepEqual(own.report.scope.typescript, { version: "5.9.3", source: "project" });
  assert.deepEqual(own.report.diagnostics.filter(isError), []);
  assert.equal(own.code, 0);
});

test("TypeScript 5 accepts what it does not deprecate, and the plan fixture", (t) => {
  const root = copyFixture(t, "vertical");
  installTypeScript5(root);
  editFile(root, "tsconfig.json", (s) => s.replace('"strict": true,', '"strict": true,\n    "baseUrl": ".",'));

  const { code, report } = check(root);
  assert.equal(code, 0);
  assert.deepEqual(report.scope.typescript, { version: "5.9.3", source: "project" });
  assert.deepEqual(report.counts, { contracts: 3, data: 1, invariants: 8, implementations: null, testDeclarations: null, linkedInvariants: null, reviewedInvariants: null, weakInvariants: null });

  const text = editFile(root, QUOTA, (s) => s.replace("take(accountId: AccountId)", "take(accountId: AccountIdd)"));
  assert.deepEqual(
    check(root).report.diagnostics.filter(isError).map(summary),
    [{ code: "E_TYPESCRIPT", tsCode: 2552, file: QUOTA, ...find(text, "AccountIdd") }],
  );
});

test("without a usable TypeScript in the project the bundled one is used", (t) => {
  // Outside the repository, so that no `typescript` package is found above the project.
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "design-harness-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(loadTypeScript(root).info, { version: "6.0.3", source: "bundled" });

  // TypeScript 7 ships no compiler API under its main entry, only a version.
  writeFile(root, "node_modules/typescript/package.json", JSON.stringify({ name: "typescript", version: "7.0.2", main: "index.js" }));
  writeFile(root, "node_modules/typescript/index.js", 'module.exports = { version: "7.0.2" };\n');
  assert.deepEqual(loadTypeScript(root).info, { version: "6.0.3", source: "bundled", fallbackReason: "the project's TypeScript 7.0.2 has no usable compiler API" });

  writeFile(root, "package.json", JSON.stringify({ private: true, type: "module" }));
  writeFile(root, "tsconfig.json", JSON.stringify({ compilerOptions: { module: "NodeNext", strict: true, noEmit: true } }));
  writeFile(root, "src/a/a.cage.mdx", mdx(contract("Thing", "run(): void;", "@invariant ok Працює.")));
  const text = cli(root, "check", "--phase", "design");
  assert.equal(text.code, 0);
  assert.equal(
    text.stdout,
    "check --phase design: 1 design, 1 contract, 0 data types, 1 invariant; 0 errors, 0 warnings. TypeScript 6.0.3 (bundled; the project's TypeScript 7.0.2 has no usable compiler API).\n",
  );
});

test("a TypeScript that Node finds outside the project's node_modules is not the project's", (t) => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "design-harness-"));
  const elsewhere = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "design-harness-global-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }));
  fs.symlinkSync(path.join(repository, "node_modules/typescript-5"), path.join(elsewhere, "typescript"));

  // NODE_PATH is read when Node starts, so this needs a process of its own.
  const script = `import { loadTypeScript } from ${JSON.stringify(path.join(repository, "src/typescript.ts"))}; console.log(JSON.stringify(loadTypeScript(${JSON.stringify(root)}).info));`;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: { ...process.env, NODE_PATH: elsewhere } });
  assert.equal(run.stderr, "");
  assert.deepEqual(JSON.parse(run.stdout), { version: "6.0.3", source: "bundled" });
});

test("a project TypeScript that cannot be loaded does not stop the check", (t) => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "design-harness-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeFile(root, "node_modules/typescript/package.json", JSON.stringify({ name: "typescript", version: "5.9.3", main: "index.js" }));
  writeFile(root, "node_modules/typescript/index.js", 'throw new Error("corrupted install");\n');

  assert.deepEqual(loadTypeScript(root).info, { version: "6.0.3", source: "bundled", fallbackReason: "the project's TypeScript cannot be loaded: corrupted install" });

  // An interrupted install: the package is there, its entry file is not. That is not "no TypeScript".
  const partial = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "design-harness-"));
  t.after(() => fs.rmSync(partial, { recursive: true, force: true }));
  writeFile(partial, "node_modules/typescript/package.json", JSON.stringify({ name: "typescript", version: "5.9.3", main: "lib/typescript.js" }));
  assert.match(loadTypeScript(partial).info.fallbackReason ?? "", /^the project's TypeScript cannot be loaded: Cannot find module/);

  const odd = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "design-harness-"));
  t.after(() => fs.rmSync(odd, { recursive: true, force: true }));
  writeFile(odd, "node_modules/typescript/package.json", JSON.stringify({ name: "typescript", version: "5.9.3", main: "index.js" }));
  writeFile(odd, "node_modules/typescript/index.js", 'throw "boom";\n');
  assert.equal(loadTypeScript(odd).info.fallbackReason, "the project's TypeScript cannot be loaded: boom");
  // A configuration error is still reported as one, in the requested format.
  const { code, stdout, stderr } = cli(root, "check", "--phase", "design", "--format", "json", "--config", "nope.json");
  assert.equal(code, 2);
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout).diagnostics.map((diagnostic: { code: string }) => diagnostic.code), ["E_CONFIG"]);
});

/** The warning for a contract that nobody has reviewed yet, as the text report prints it. */
function reviewMissing(design: string, name: string): string {
  const { line, column } = inFixture(design, `${name} {`);
  return `${design}:${line}:${column}: warning W_REVIEW_MISSING: Contract "${name}" has no recorded review. Run \`cage review ${name}\`, have the material reviewed, and record the verdict with \`cage review --record\`.`;
}

function fullCheck(root: string, ...args: string[]): { code: number; report: CheckReport } {
  const { code, stdout, stderr } = cli(root, "check", "--format", "json", ...args);
  assert.equal(stderr, "");
  return { code, report: JSON.parse(stdout) };
}

const linked = (report: CheckReport) => Object.fromEntries((report.invariants ?? []).map(({ contract, id, linkedTestCount }) => [`${contract}: ${id}`, linkedTestCount]));

test("check reports the whole plan fixture: 3 implementations, 8 linked invariants", (t) => {
  const root = copyFixture(t, "vertical");
  const before = snapshot(root);

  const { code, report } = fullCheck(root);
  assert.equal(code, 0);
  assert.equal(report.phase, "implementation");
  assert.equal(report.ok, true);
  assert.deepEqual(report.counts, { contracts: 3, data: 1, invariants: 8, implementations: 3, testDeclarations: 8, linkedInvariants: 8, reviewedInvariants: 0, weakInvariants: 0 });
  assert.deepEqual(linked(report), {
    "Send: quota": 1,
    "Send: limit": 1,
    "Send: quota-error": 1,
    "Send: sender-error": 1,
    "Quota: accounts": 1,
    "Quota: empty": 1,
    "Quota: consume": 1,
    "Quota: race": 1,
  });
  assert.deepEqual(report.scope.compilerOptions, { strictNullChecks: true, strictFunctionTypes: true, noImplicitAny: true });
  // Nothing has been reviewed yet: by default that is a warning per contract, in the order of the documents.
  assert.deepEqual(report.diagnostics.map((diagnostic) => diagnostic.code), ["W_REVIEW_MISSING", "W_NO_INVARIANTS", "W_REVIEW_MISSING", "W_REVIEW_MISSING"]);
  // Nothing in the report claims that a test ran or passed.
  assert.doesNotMatch(JSON.stringify(report), /passed|failed|proven|testRunStatus/);
  assert.deepEqual(snapshot(root), before);

  assert.equal(
    cli(root, "check").stdout,
    [
      reviewMissing(CAMPAIGNS, "Send"),
      senderWarning(),
      reviewMissing(MAIL, "Sender"),
      reviewMissing(QUOTA, "Quota"),
      "check: 3 designs, 3 contracts, 1 data type, 8 invariants, 3 implementations, 8 test declarations, 8 of 8 invariants linked to a test declaration (0 confirmed by review, 0 found weak, 8 unreviewed); 0 errors, 4 warnings. TypeScript 6.0.3 (project).",
      "",
    ].join("\n"),
  );
  assert.equal(cli(root, "check", "--phase", "implementation").stdout, cli(root, "check").stdout);
});

test("an invariant without a test and a contract without an implementation are errors of check, not of the design phase", (t) => {
  const root = copyFixture(t, "vertical");
  editFile(root, "src/modules/quota/quota.test.ts", (s) => s.replace("/** @covers race */", ""));
  editFile(root, "src/modules/mail/callback-sender.ts", (s) => s.replace("/** @implements Sender */", ""));

  assert.equal(check(root).code, 0);
  const { code, report } = fullCheck(root);
  assert.equal(code, 1);
  assert.deepEqual(
    report.diagnostics.filter(isError).map(({ code, contract, invariant, ...rest }) => ({ code, contract, invariant, file: rest.file, line: rest.line, column: rest.column })),
    [
      { code: "E_IMPLEMENTATION_MISSING", contract: "Sender", invariant: undefined, ...inFixture(MAIL, "Sender {") },
      { code: "E_TEST_MISSING", contract: "Quota", invariant: "race", ...inFixture(QUOTA, "@invariant race") },
    ],
  );
  assert.equal(linked(report)["Quota: race"], 0);
  assert.deepEqual(report.counts, { contracts: 3, data: 1, invariants: 8, implementations: 2, testDeclarations: 8, linkedInvariants: 7, reviewedInvariants: 0, weakInvariants: 0 });
  // The class that lost its tag is now also code that no design covers.
  const sender = inFixture("src/modules/mail/callback-sender.ts", "CallbackSender");
  assert.ok(cli(root, "check").stdout.includes(`${sender.file}:${sender.line}:${sender.column}: warning W_NOT_DESIGNED: Exported class "CallbackSender"`));
  assert.match(cli(root, "check").stdout, /2 implementations, 8 test declarations, 7 of 8 invariants linked to a test declaration \(0 confirmed by review, 0 found weak, 8 unreviewed\); 2 errors, 5 warnings\./);
});

test("with an error in a design nothing beyond the designs is checked, and the report says so", (t) => {
  const root = copyFixture(t, "vertical");
  editFile(root, MAIL, (s) => s.replace("send(text: string)", "send(text: Txt)"));

  const { code, report } = fullCheck(root);
  assert.equal(code, 1);
  assert.deepEqual(report.diagnostics.filter(isError).map((diagnostic) => diagnostic.code), ["E_TYPESCRIPT"]);
  assert.deepEqual(report.counts, { contracts: 3, data: 1, invariants: 8, implementations: null, testDeclarations: null, linkedInvariants: null, reviewedInvariants: null, weakInvariants: null });
  assert.deepEqual([...new Set(Object.values(linked(report)))], [null]);
  assert.match(cli(root, "check").stdout, /8 invariants, implementations and tests not checked; 1 error, 1 warning\./);
});

test("weakened compiler options are a warning, with the effective values in the report", (t) => {
  const root = copyFixture(t, "vertical");
  editFile(root, "tsconfig.json", (s) => s.replace('"strict": true,', '"strict": true,\n    "strictNullChecks": false,\n    "noImplicitAny": false,'));
  // However the configuration spells the path, the report names the file from the project root.
  writeFile(root, ".cage/config.json", '{ "version": 1, "tsconfig": "./src/../tsconfig.json" }');

  const { code, report } = fullCheck(root);
  assert.equal(code, 0);
  assert.deepEqual(report.scope.compilerOptions, { strictNullChecks: false, strictFunctionTypes: true, noImplicitAny: false });
  assert.deepEqual(
    report.diagnostics.filter((diagnostic) => diagnostic.code === "W_WEAK_TYPECHECK"),
    [
      {
        code: "W_WEAK_TYPECHECK",
        severity: "warning",
        message: "The project's compiler options weaken the comparison of implementations with contracts: strictNullChecks, noImplicitAny are off.",
        file: "tsconfig.json",
      },
    ],
  );
  // The design phase compares no implementations, so it does not warn; it still reports the values.
  assert.deepEqual(check(root).report.diagnostics.map((diagnostic) => diagnostic.code), ["W_NO_INVARIANTS"]);
  assert.deepEqual(check(root).report.scope.compilerOptions, report.scope.compilerOptions);
});

test("under TypeScript 5 `strict` is off unless the project turns it on", (t) => {
  const root = copyFixture(t, "vertical");
  installTypeScript5(root);

  const strict = fullCheck(root);
  assert.equal(strict.code, 0);
  assert.deepEqual(strict.report.scope.typescript, { version: "5.9.3", source: "project" });
  assert.deepEqual(strict.report.counts, { contracts: 3, data: 1, invariants: 8, implementations: 3, testDeclarations: 8, linkedInvariants: 8, reviewedInvariants: 0, weakInvariants: 0 });
  assert.deepEqual(strict.report.diagnostics.map((diagnostic) => diagnostic.code).filter((code) => code !== "W_REVIEW_MISSING"), ["W_NO_INVARIANTS"]);

  editFile(root, "tsconfig.json", (s) => s.replace('"strict": true,', ""));
  const loose = fullCheck(root);
  assert.deepEqual(loose.report.scope.compilerOptions, { strictNullChecks: false, strictFunctionTypes: false, noImplicitAny: false });
  assert.deepEqual(loose.report.diagnostics.map((diagnostic) => diagnostic.code).filter((code) => code !== "W_REVIEW_MISSING"), ["W_NO_INVARIANTS", "W_WEAK_TYPECHECK"]);
});

test("files that cannot be read are environment errors in the report, not a crash", { skip: process.getuid?.() === 0 }, (t) => {
  const root = copyFixture(t, "vertical");
  const locked = ["src/modules/quota/quota.test.ts"];
  for (const file of locked) fs.chmodSync(path.join(root, file), 0o000);
  try {
    const { code, report } = fullCheck(root);
    assert.equal(code, 2);
    // The test file is also one of the project's files, so the compiler reports it as well, through the tsconfig.
    assert.deepEqual(
      report.diagnostics.filter((diagnostic) => diagnostic.code === "E_ENVIRONMENT").map((diagnostic) => diagnostic.file),
      [...locked, "tsconfig.json"],
    );
  } finally {
    for (const file of locked) fs.chmodSync(path.join(root, file), 0o644);
  }
});

test("a tsconfig problem that shows only with the project's files is an environment error", (t) => {
  const root = copyFixture(t, "vertical");
  editFile(root, "tsconfig.json", (s) => s.replace('"include": ["src/**/*.ts"]', '"files": ["src/missing.ts"]'));

  // The design phase compiles the designs alone and does not see it.
  assert.equal(check(root).code, 0);
  const { code, report } = fullCheck(root);
  assert.equal(code, 2);
  assert.deepEqual(report.diagnostics.filter(isError).map(({ code, tsCode, file }) => ({ code, tsCode, file })), [{ code: "E_ENVIRONMENT", tsCode: 6053, file: "tsconfig.json" }]);
  assert.deepEqual(report.counts.implementations, null);
});
