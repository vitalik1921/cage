import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import type { CheckReport } from "../src/check.ts";
import type { DraftReport } from "../src/draft.ts";
import { CAMPAIGNS, cli, cliWithStdin, contract, copyFixture, data, designFile, designProject, editFile, find, MAIL, mdx, QUOTA, readFile, scratchDirectory, snapshot, writeFile } from "./helpers.ts";

const repository = path.join(import.meta.dirname, "..");
const QUOTA_DRAFT = "src/modules/quota/quota.cage.draft.mdx";

/** `cage draft <action> <path>` as JSON; any extra arguments follow. */
function draft(root: string, action: string, file: string, ...args: string[]): { code: number; report: DraftReport } {
  const { code, stdout, stderr } = cli(root, "draft", action, file, "--format", "json", ...args);
  assert.equal(stderr, "");
  return { code, report: JSON.parse(stdout) };
}

const checkDesigns = (root: string, ...args: string[]): { code: number; report: CheckReport } => {
  const { code, stdout } = cli(root, "check", "--phase", "design", "--format", "json", ...args);
  return { code, report: JSON.parse(stdout) };
};

/** The digest a draft header holds, computed here from its definition: SHA-256 of the text with `\n` line endings. */
const sha256 = (text: string) => `sha256:${crypto.createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex")}`;

/** The codes of the errors in a report; warnings such as the fixture's own W_NO_INVARIANTS are left out. */
/** The text report's heading and its facts, `label: value` one a line, read back so that tests assert meanings, not layout. */
function textFacts(stdout: string): { heading: string; facts: Record<string, string> } {
  const lines = stdout.trimEnd().split("\n");
  const start = lines.findLastIndex((line) => line.startsWith("draft "));
  assert.ok(start >= 0, stdout);
  const facts = Object.fromEntries(lines.slice(start + 1).map((line) => /^ {2}([a-z ]+):\s+(.*)$/.exec(line)).map((match) => [match?.[1], match?.[2]]));
  assert.ok(!("undefined" in facts), stdout);
  // The wording stays short; a next command is as long as the paths it repeats.
  for (const line of lines.slice(start).filter((line) => !line.startsWith("  next:"))) assert.ok(line.length <= 100, `a long line: ${line}`);
  return { heading: lines[start], facts };
}

const codes = (report: { diagnostics: { code: string; severity: string }[] }) => report.diagnostics.filter(({ severity }) => severity === "error").map(({ code }) => code);

/** The files of a snapshot but the given ones. */
const without = (files: Record<string, string>, ...except: string[]) => Object.fromEntries(Object.entries(files).filter(([file]) => !except.includes(file)));

/** @tests Cli */
describe("cage draft: create, check and activate", () => {
  /** @covers draft-create draft-activate */
  it("copies the design under a header, and activation writes the edited content without it and consumes the draft", (t) => {
    const root = copyFixture(t, "vertical");
    assert.equal(cli(root, "review", "--accept").code, 0);
    const active = readFile(root, QUOTA);

    const created = draft(root, "create", QUOTA);
    assert.equal(created.code, 0);
    assert.deepEqual(created.report, {
      schemaVersion: 1,
      command: "draft",
      action: "create",
      ok: true,
      draft: QUOTA_DRAFT,
      target: QUOTA,
      base: sha256(active),
      status: "created",
      validation: null,
      diagnostics: [],
    });
    assert.equal(readFile(root, QUOTA_DRAFT), `{/* cage draft v1\ntarget: ${QUOTA}\nbase: ${sha256(active)}\n*/}\n${active}`);
    assert.equal(readFile(root, QUOTA), active);

    const proposed = active.replace("Квота визначає", "Квота (v2) визначає").replace("take(accountId: AccountId): Promise<boolean>;", "take(accountId: AccountId): Promise<boolean>;\n  left(accountId: AccountId): Promise<number>;");
    editFile(root, QUOTA_DRAFT, (text) => text.replace(active, proposed));
    const before = snapshot(root);

    const activated = draft(root, "activate", QUOTA_DRAFT);
    assert.equal(activated.code, 0, JSON.stringify(activated.report.diagnostics));
    assert.equal(activated.report.status, "activated");
    assert.equal(readFile(root, QUOTA), proposed);
    assert.equal(fs.existsSync(path.join(root, QUOTA_DRAFT)), false);
    // Nothing else is written: the review file keeps the acceptance of the old material, no lock file appears.
    assert.deepEqual(without(snapshot(root), QUOTA), without(before, QUOTA, QUOTA_DRAFT));
    // The active check now sees the new design, and the review of its contract as outdated: no verdict was carried over.
    const full = JSON.parse(cli(root, "check", "--format", "json").stdout) as CheckReport;
    assert.ok(full.diagnostics.some(({ code, contract: name }) => code === "W_REVIEW_STALE" && name === "Quota"), JSON.stringify(full.diagnostics));
  });

  /** @covers draft-create */
  it("scaffolds a new design for a document that does not exist, with a null base, and never overwrites a file", (t) => {
    const root = copyFixture(t, "vertical");
    const target = "src/modules/billing/billing.cage.mdx";
    const billingDraft = "src/modules/billing/billing.cage.draft.mdx";

    const created = draft(root, "create", target);
    assert.equal(created.code, 0);
    assert.equal(created.report.base, null);
    const text = readFile(root, billingDraft);
    assert.ok(text.startsWith(`{/* cage draft v1\ntarget: ${target}\nbase: null\n*/}\n# billing\n`), text);
    assert.match(text, /```ts design\n[\s\S]*@contract[\s\S]*export interface Billing \{/);
    assert.equal(fs.existsSync(path.join(root, target)), false);
    // The scaffold is a design the candidate check accepts; its one finding points into the draft.
    const checked = draft(root, "check", billingDraft);
    assert.equal(checked.code, 0);
    const warning = checked.report.diagnostics.find(({ code, file }) => code === "W_NO_INVARIANTS" && file === billingDraft);
    assert.deepEqual(warning && { line: warning.line, column: warning.column }, find(text, "Billing {"));

    // A second create, or a create over anything at the draft's path, writes nothing.
    const before = snapshot(root);
    const again = draft(root, "create", target);
    assert.equal(again.code, 1);
    assert.deepEqual(codes(again.report), ["E_DRAFT"]);
    assert.equal(again.report.status, "refused");
    fs.writeFileSync(path.join(root, QUOTA_DRAFT), "a person's notes\n");
    const taken = draft(root, "create", QUOTA);
    assert.equal(taken.code, 1);
    assert.deepEqual(codes(taken.report), ["E_DRAFT"]);
    assert.equal(readFile(root, QUOTA_DRAFT), "a person's notes\n");
    fs.rmSync(path.join(root, QUOTA_DRAFT));
    fs.symlinkSync("nowhere.mdx", path.join(root, QUOTA_DRAFT));
    assert.deepEqual(codes(draft(root, "create", QUOTA).report), ["E_DRAFT"]);
    assert.equal(fs.readlinkSync(path.join(root, QUOTA_DRAFT)), "nowhere.mdx");
    fs.rmSync(path.join(root, QUOTA_DRAFT));
    assert.deepEqual(snapshot(root), before);
  });

  /** @covers draft-candidate draft-isolation */
  it("checks the candidate under the target's path: consumers import it, even a new document, and drafts cannot be imported", (t) => {
    const root = copyFixture(t, "vertical");
    assert.equal(draft(root, "create", "src/modules/billing/billing.cage.mdx").code, 0);
    const billingDraft = "src/modules/billing/billing.cage.draft.mdx";
    editFile(root, billingDraft, (text) => text.replace("```ts design\n", "```ts design\n/**\n * @data\n * @description An invoice number.\n */\nexport type InvoiceId = string;\n\n"));
    // An active design that imports the new document by its future path does not pass on its own...
    editFile(root, CAMPAIGNS, (text) => text.replace('import type { AccountId } from "../quota/quota.cage.mdx";', 'import type { AccountId } from "../quota/quota.cage.mdx";\nimport type { InvoiceId } from "../billing/billing.cage.mdx";\n/**\n * @data\n * @description An invoiced send.\n */\nexport type Invoiced = InvoiceId;'));
    assert.equal(checkDesigns(root).code, 1);
    // ...and does with the candidate in place: the import resolves to it.
    const before = snapshot(root);
    const candidate = draft(root, "check", billingDraft);
    assert.equal(candidate.code, 0, JSON.stringify(candidate.report.diagnostics));
    assert.equal(candidate.report.status, "valid");
    assert.deepEqual(snapshot(root), before);
    // Only the draft named is a candidate: checking the quota draft, the billing document is still absent.
    assert.equal(draft(root, "create", QUOTA).code, 0);
    const other = draft(root, "check", QUOTA_DRAFT).report.diagnostics.find(({ code }) => code === "E_DESIGN_OUT_OF_SCOPE");
    assert.deepEqual(other && { file: other.file, line: other.line }, { file: CAMPAIGNS, line: find(readFile(root, CAMPAIGNS), "billing.cage.mdx").line });
    assert.equal(draft(root, "activate", billingDraft).code, 0);
    assert.equal(checkDesigns(root).code, 0);

    // A consumer of an existing design sees the candidate, not the active file: taking a type away breaks it at the consumer.
    editFile(root, QUOTA_DRAFT, (text) => text.replace("export type AccountId = string;", "export type AccountKey = string;").replace("take(accountId: AccountId)", "take(accountId: AccountKey)"));
    const broken = draft(root, "check", QUOTA_DRAFT);
    assert.equal(broken.code, 1);
    const consumer = broken.report.diagnostics.find(({ code }) => code === "E_TYPESCRIPT");
    assert.deepEqual(consumer && { file: consumer.file, line: consumer.line }, { file: CAMPAIGNS, line: find(readFile(root, CAMPAIGNS), "AccountId }").line });

    // A candidate may not import another draft, and an active design may not import one either.
    editFile(root, QUOTA_DRAFT, (text) => text.replace("export type AccountKey = string;", 'export type AccountKey = string;\nexport type { InvoiceId } from "../billing/billing.cage.draft.mdx";').replaceAll("AccountKey", "AccountId"));
    const importing = draft(root, "check", QUOTA_DRAFT);
    const imported = importing.report.diagnostics.find(({ code }) => code === "E_DESIGN_IMPORT");
    assert.deepEqual(imported && { file: imported.file, line: imported.line }, { file: QUOTA_DRAFT, line: find(readFile(root, QUOTA_DRAFT), "billing.cage.draft.mdx").line });
    assert.equal(importing.code, 1);
    editFile(root, MAIL, (text) => text.replace("```ts design\n", '```ts design\nimport type { AccountId } from "../quota/quota.cage.draft.mdx";\n'));
    assert.ok(codes(checkDesigns(root).report).includes("E_DESIGN_IMPORT"));
  });

  /** @covers draft-candidate diagnostic-line */
  it("reports the candidate's diagnostics at the draft's own lines and says what it did not check", (t) => {
    const root = copyFixture(t, "vertical");
    assert.equal(draft(root, "create", QUOTA).code, 0);
    editFile(root, QUOTA_DRAFT, (text) => text.replace("take(accountId: AccountId)", "take(accountId: Missing)").replace("@invariant race", "@invariant race Once more.\n   * @invariant race"));
    const text = readFile(root, QUOTA_DRAFT);
    const { code, report } = draft(root, "check", QUOTA_DRAFT);
    assert.equal(code, 1);
    assert.equal(report.status, "invalid");
    const at = (wanted: string) => {
      const found = report.diagnostics.find(({ code: actual }) => actual === wanted);
      return found && { file: found.file, line: found.line };
    };
    assert.deepEqual(at("E_INVARIANT_DUPLICATE"), { file: QUOTA_DRAFT, line: find(text, "@invariant race").line + 1 });
    assert.deepEqual(report.validation && { ...report.validation, typescript: undefined }, { mode: "candidate", designs: "checked", locks: "not-checked", implementations: "not-checked", tests: "not-checked", reviews: "not-checked", typescript: undefined });

    editFile(root, QUOTA_DRAFT, (value) => value.replace("@invariant race Once more.\n   * ", ""));
    const typeError = draft(root, "check", QUOTA_DRAFT);
    const mistake = typeError.report.diagnostics.find(({ code: actual }) => actual === "E_TYPESCRIPT");
    const expected = find(readFile(root, QUOTA_DRAFT), "Missing");
    assert.deepEqual(mistake && { file: mistake.file, line: mistake.line, column: mistake.column }, { file: QUOTA_DRAFT, ...expected });

    const textReport = cli(root, "draft", "check", QUOTA_DRAFT);
    assert.equal(textReport.code, 1);
    const { heading, facts } = textFacts(textReport.stdout);
    assert.match(heading, /^draft check: not valid \(1 error, 1 warning\)$/);
    assert.equal(facts.draft, QUOTA_DRAFT);
    assert.equal(facts.target, `${QUOTA} (unchanged)`);
    assert.equal(facts.checked, "designs, with the draft in place of the target");
    assert.equal(facts["not checked"], "locks, implementations, tests, reviews");
    assert.equal(facts.written, "nothing");
    assert.equal(facts.next, undefined);
    assert.match(textReport.stdout, new RegExp(`^E_TYPESCRIPT: Cannot find name 'Missing'\\. \\(${QUOTA_DRAFT.replaceAll(".", "\\.")}:${expected.line}:${expected.column}, TS2304\\)$`, "m"));
  });

  /** @covers draft-candidate draft-activate */
  it("reports unchecked locks honestly when their record is malformed, and refuses without writes", (t) => {
    const root = copyFixture(t, "vertical");
    assert.equal(draft(root, "create", QUOTA).code, 0);
    writeFile(root, ".cage/lock.json", "{not json");
    const before = snapshot(root);
    for (const action of ["check", "activate"]) {
      const result = draft(root, action, QUOTA_DRAFT);
      assert.equal(result.code, 2);
      assert.equal(result.report.validation?.locks, "not-checked");
      assert.ok(result.report.diagnostics.some(({ code, file }) => code === "E_CONFIG" && file === ".cage/lock.json"));
      const text = cli(root, "draft", action, QUOTA_DRAFT);
      assert.equal(text.code, 2);
      const { facts } = textFacts(text.stdout);
      assert.equal(facts["not checked"], "locks, implementations, tests, reviews");
      assert.doesNotMatch(text.stdout, /the designs have errors/);
    }
    assert.deepEqual(snapshot(root), before);
  });

  /** @covers draft-activate */
  it("refuses activation while the active design differs from the draft's base, reading it live, and writes nothing", (t) => {
    const root = copyFixture(t, "vertical");
    const active = readFile(root, QUOTA);
    assert.equal(draft(root, "create", QUOTA).code, 0);
    editFile(root, QUOTA_DRAFT, (text) => text.replace("Квота визначає", "Квота (v2) визначає"));
    assert.equal(draft(root, "check", QUOTA_DRAFT).code, 0);

    // Edited after the draft was checked: the activation compares with the design as it is now.
    fs.writeFileSync(path.join(root, QUOTA), `${active}\nA person's later rule.\n`);
    const before = snapshot(root);
    for (const action of ["check", "activate"]) {
      const { code, report } = draft(root, action, QUOTA_DRAFT);
      assert.equal(code, 1);
      const conflict = report.diagnostics.find(({ code: actual }) => actual === "E_DRAFT_CONFLICT");
      assert.deepEqual(conflict && { file: conflict.file, line: conflict.line }, { file: QUOTA_DRAFT, line: find(readFile(root, QUOTA_DRAFT), "base:").line });
    }
    assert.deepEqual(snapshot(root), before);

    // Deleted: also a conflict, and the design is not recreated.
    fs.rmSync(path.join(root, QUOTA));
    assert.deepEqual(codes(draft(root, "activate", QUOTA_DRAFT).report), ["E_DRAFT_CONFLICT"]);
    assert.equal(fs.existsSync(path.join(root, QUOTA)), false);

    // The same text again, even with other line endings, is the base: the digest is of the text, not of the file's history.
    fs.writeFileSync(path.join(root, QUOTA), active.replaceAll("\n", "\r\n"));
    const activated = draft(root, "activate", QUOTA_DRAFT);
    assert.equal(activated.code, 0, JSON.stringify(activated.report.diagnostics));
    assert.match(readFile(root, QUOTA), /Квота \(v2\) визначає/);

    // A draft of a new document conflicts with a document created in the meantime.
    assert.equal(draft(root, "create", "src/modules/billing/billing.cage.mdx").code, 0);
    writeFile(root, "src/modules/billing/billing.cage.mdx", mdx(contract("Billing")));
    const created = snapshot(root);
    assert.deepEqual(codes(draft(root, "activate", "src/modules/billing/billing.cage.draft.mdx").report), ["E_DRAFT_CONFLICT"]);
    assert.deepEqual(snapshot(root), created);
  });

  /** @covers draft-activate exit-codes */
  it("refuses an invalid candidate, a broken consumer or an unusable configuration, keeping both files byte for byte", (t) => {
    const root = copyFixture(t, "vertical");
    assert.equal(draft(root, "create", QUOTA).code, 0);
    const original = readFile(root, QUOTA_DRAFT);
    for (const edit of [
      (text: string) => text.replace("export type AccountId = string;", "export type AccountKey = string;").replace("take(accountId: AccountId)", "take(accountId: AccountKey)"),
      (text: string) => text.replace("```ts design", "```ts design\nexport const value = 1;"),
      (text: string) => `${text}\n<Unclosed\n`,
    ]) {
      fs.writeFileSync(path.join(root, QUOTA_DRAFT), edit(original));
      const before = snapshot(root);
      const { code, report } = draft(root, "activate", QUOTA_DRAFT);
      assert.equal(code, 1);
      assert.equal(report.status, "refused");
      assert.deepEqual(snapshot(root), before);
    }
    fs.writeFileSync(path.join(root, QUOTA_DRAFT), original);
    writeFile(root, ".cage/config.json", JSON.stringify({ version: 1, unknown: true }));
    const before = snapshot(root);
    const configured = draft(root, "activate", QUOTA_DRAFT);
    assert.equal(configured.code, 2);
    assert.deepEqual(codes(configured.report), ["E_CONFIG"]);
    assert.equal(configured.report.validation, null);
    assert.equal(draft(root, "create", MAIL).code, 2);
    assert.deepEqual(snapshot(root), before);
  });

  /** @covers draft-activate */
  it("keeps @final: changed, renamed, unmarked or removed locked declarations are refused; a new lock waits for cage lock", (t) => {
    const store = "src/store/store.cage.mdx";
    const storeDraft = "src/store/store.cage.draft.mdx";
    const design = mdx(data("Key", "string", ), contract("Store", "get(key: Key): string;", "@final", "@invariant found Returns the stored value."));
    const root = designProject(t, { store: design.replace(" * @data\n", " * @data\n * @final\n") });
    assert.equal(designFile("store"), store);
    assert.equal(cli(root, "lock").code, 0);
    const lockFile = readFile(root, ".cage/lock.json");
    assert.equal(draft(root, "create", store).code, 0);
    const original = readFile(root, storeDraft);

    for (const [label, edit] of [
      ["signature", (text: string) => text.replace("get(key: Key): string;", "get(key: Key): string | null;")],
      ["invariant", (text: string) => text.replace("Returns the stored value.", "Returns a value.")],
      ["rename", (text: string) => text.replace("interface Store", "interface Storage")],
      ["marker", (text: string) => text.replace(" * @final\n * @invariant", " * @invariant")],
      ["locked data", (text: string) => text.replace("export type Key = string;", "export type Key = number;")],
      ["removal", (text: string) => text.replace(/\/\*\*\n \* @contract[\s\S]*?\n\}\n/, `${contract("Other")}\n`)],
    ] as const) {
      fs.writeFileSync(path.join(root, storeDraft), edit(original));
      const before = snapshot(root);
      const { code, report } = draft(root, "activate", storeDraft);
      assert.equal(code, 1, label);
      assert.ok(codes(report).includes("E_LOCK_VIOLATION"), `${label}: ${JSON.stringify(report.diagnostics)}`);
      assert.deepEqual(snapshot(root), before, label);
    }

    // A new lock is not recorded by activation: the candidate passes with a warning, and check then requires cage lock.
    fs.writeFileSync(path.join(root, storeDraft), original.replace(/```\n$/, "```\n\n```ts design\n" + contract("Audit", "log(): void;", "@final") + "\n```\n"));
    const checked = draft(root, "check", storeDraft);
    assert.equal(checked.code, 0, JSON.stringify(checked.report.diagnostics));
    const unrecorded = checked.report.diagnostics.find(({ code }) => code === "W_LOCK_UNRECORDED");
    assert.deepEqual(unrecorded && { file: unrecorded.file, line: unrecorded.line }, { file: storeDraft, line: find(readFile(root, storeDraft), "interface Audit").line });
    assert.equal(draft(root, "activate", storeDraft).code, 0);
    assert.equal(readFile(root, ".cage/lock.json"), lockFile);
    const after = checkDesigns(root);
    assert.equal(after.code, 1);
    assert.deepEqual(codes(after.report), ["E_LOCK_MISSING"]);
    assert.equal(cli(root, "lock").code, 0);
    assert.equal(checkDesigns(root).code, 0);
  });

  /** @covers draft-activate */
  it("keeps @extendable: an added member activates and waits for cage lock; a changed recorded member is refused", (t) => {
    const store = designFile("store");
    const storeDraft = "src/store/store.cage.draft.mdx";
    const root = designProject(t, { store: mdx(contract("Store", "get(key: string): string;", "@extendable", "@invariant found Returns the stored value.")) });
    assert.equal(cli(root, "lock").code, 0);
    const lockFile = readFile(root, ".cage/lock.json");
    assert.equal(draft(root, "create", store).code, 0);
    const original = readFile(root, storeDraft);

    // Changing what is recorded is refused, the added member beside it notwithstanding.
    for (const [label, edit] of [
      ["recorded signature", (text: string) => text.replace("get(key: string): string;", "get(key: string): string | null;\n  put(key: string, value: string): void;")],
      ["recorded invariant", (text: string) => text.replace("Returns the stored value.", "Returns some value.")],
    ] as const) {
      fs.writeFileSync(path.join(root, storeDraft), edit(original));
      const before = snapshot(root);
      const { code, report } = draft(root, "activate", storeDraft);
      assert.equal(code, 1, label);
      assert.deepEqual(codes(report), ["E_LOCK_VIOLATION"], label);
      assert.deepEqual(snapshot(root), before, label);
    }

    // An added member is what @extendable allows: it activates, and is not locked until cage lock records it.
    fs.writeFileSync(path.join(root, storeDraft), original.replace("get(key: string): string;", "get(key: string): string;\n  put(key: string, value: string): void;"));
    const checked = draft(root, "check", storeDraft);
    assert.equal(checked.code, 0, JSON.stringify(checked.report.diagnostics));
    assert.deepEqual(checked.report.diagnostics.map(({ code }) => code), ["W_LOCK_UNRECORDED"]);
    assert.equal(draft(root, "activate", storeDraft).code, 0);
    assert.match(readFile(root, store), /put\(key: string, value: string\): void;/);
    assert.equal(readFile(root, ".cage/lock.json"), lockFile);
    const after = checkDesigns(root);
    assert.equal(after.code, 0);
    assert.deepEqual(after.report.diagnostics.map(({ code }) => code), ["W_LOCK_UNRECORDED"]);
    assert.equal(cli(root, "lock").code, 0);
    assert.notEqual(readFile(root, ".cage/lock.json"), lockFile);
    assert.deepEqual(checkDesigns(root).report.diagnostics, []);
  });

  /** @covers draft-isolation */
  it("leaves check, gate, lock, review freshness and coverage as they are, whatever a draft holds, even under broad patterns", (t) => {
    const root = copyFixture(t, "vertical");
    writeFile(root, ".cage/config.json", JSON.stringify({ version: 1, designs: ["src/**/*.mdx", "src/**/*.cage.draft.mdx"], review: "require", coverage: "require" }));
    assert.equal(cli(root, "review", "--accept").code, 0);
    assert.equal(cli(root, "lock").code, 0);
    const run = () => ({
      check: cli(root, "check", "--format", "json"),
      gate: cliWithStdin(root, JSON.stringify({ session_id: "drafts" }), "gate"),
      lock: cli(root, "lock", "--format", "json"),
      review: cli(root, "review", "--format", "json"),
    });
    const baseline = run();
    assert.equal(baseline.check.code, 0, baseline.check.stdout);
    assert.equal(baseline.gate.code, 0);
    const recorded = snapshot(path.join(root, ".cage"));

    assert.equal(draft(root, "create", QUOTA).code, 0);
    assert.equal(draft(root, "create", "src/modules/billing/billing.cage.mdx").code, 0);
    for (const text of [
      // A different contract, prose and an invariant: none of it is the design yet.
      readFile(root, QUOTA_DRAFT).replace("Квота визначає", "Інша квота").replace("@invariant race", "@invariant never-twice Never twice.\n   * @invariant race"),
      // Not even MDX.
      "{/* cage draft v1\n<Unclosed\n```ts design\nexport class Broken {\n",
    ]) {
      fs.writeFileSync(path.join(root, QUOTA_DRAFT), text);
      const now = run();
      for (const command of ["check", "gate", "lock", "review"] as const) {
        assert.deepEqual(now[command], baseline[command], command);
      }
      assert.deepEqual(snapshot(path.join(root, ".cage")), recorded);
    }

    // A draft's contract is no contract: code that implements it is still undesigned or unknown to the active check.
    writeFile(root, "src/modules/billing/billing.ts", "/** @implements Billing */\nexport class Billing {\n  run(): void {}\n}\n");
    const report = JSON.parse(cli(root, "check", "--format", "json").stdout) as CheckReport;
    assert.ok(codes(report).includes("E_REFERENCE_UNKNOWN"), JSON.stringify(report.diagnostics));
    assert.equal(report.counts.contracts, 3);
  });

  /** @covers draft-create draft-activate */
  it("refuses a malformed or misplaced header and keeps the draft and the design", (t) => {
    const root = copyFixture(t, "vertical");
    assert.equal(draft(root, "create", QUOTA).code, 0);
    const original = readFile(root, QUOTA_DRAFT);
    const elsewhere = "src/modules/mail/mail.cage.draft.mdx";
    for (const [label, file, text, line] of [
      ["no header", QUOTA_DRAFT, original.replace(/^\{\/\*[\s\S]*?\*\/\}\n/, ""), 1],
      ["another version", QUOTA_DRAFT, original.replace("cage draft v1", "cage draft v2"), 1],
      ["short digest", QUOTA_DRAFT, original.replace(/base: sha256:([0-9a-f]{8})[0-9a-f]+/, "base: sha256:$1"), 1],
      ["base left out", QUOTA_DRAFT, original.replace(/base: .*\n/, ""), 1],
      ["another target", QUOTA_DRAFT, original.replace(`target: ${QUOTA}`, `target: ${MAIL}`), 2],
      ["moved to another module", elsewhere, original, 2],
    ] as const) {
      fs.writeFileSync(path.join(root, QUOTA_DRAFT), file === QUOTA_DRAFT ? text : original);
      if (file !== QUOTA_DRAFT) fs.writeFileSync(path.join(root, file), text);
      const before = snapshot(root);
      for (const action of ["check", "activate"]) {
        const { code, report } = draft(root, action, file);
        assert.equal(code, 1, label);
        assert.deepEqual(report.diagnostics.map(({ code: actual, file: at, line: where }) => ({ code: actual, file: at, line: where })), [{ code: "E_DRAFT", file, line }], label);
        assert.equal(report.validation, null, label);
      }
      assert.deepEqual(snapshot(root), before, label);
      if (file !== QUOTA_DRAFT) fs.rmSync(path.join(root, file));
    }
    fs.writeFileSync(path.join(root, QUOTA_DRAFT), original.replace("cage draft v1", "cage draft v2"));
    assert.match(cli(root, "draft", "check", QUOTA_DRAFT).stdout, /^E_DRAFT: header version 2 is not supported/m);
  });

  /** @covers draft-create exit-codes */
  it("takes paths relative to the project root, inside it, without links and in the designs patterns", (t) => {
    const root = copyFixture(t, "vertical");
    const outside = scratchDirectory(t, "outside");
    writeFile(outside, "x/x.cage.mdx", mdx(contract("Outside")));
    const outsideBefore = snapshot(outside);
    const before = snapshot(root);

    // The form of the path is an argument error, before anything is read.
    for (const [args, message] of [
      [["draft"], /draft needs an action/],
      [["draft", "open", QUOTA], /Unknown draft action "open"/],
      [["draft", "create"], /draft create needs the path of a design document/],
      [["draft", "create", QUOTA, MAIL], /Unexpected argument/],
      [["draft", "create", path.join(outside, "x/x.cage.mdx")], /is absolute/],
      [["draft", "create", `../${path.basename(outside)}/x/x.cage.mdx`], /leaves its directory/],
      [["draft", "create", "src/modules/../modules/quota/quota.cage.mdx"], /leaves its directory/],
      [["draft", "create", QUOTA_DRAFT], /is a draft, its design is src\/modules\/quota\/quota\.cage\.mdx/],
      [["draft", "check", QUOTA], /the draft of .* is src\/modules\/quota\/quota\.cage\.draft\.mdx/],
      [["draft", "activate", "src/modules/quota/quota.mdx"], /is not a draft/],
      [["draft", "create", "src/modules/quota/.cage.mdx"], /is not a design document/],
      [["draft", "check", QUOTA_DRAFT, "--phase", "design"], /--phase is an option of the check command/],
      [["draft", "check", QUOTA_DRAFT, "--all"], /--all is an option of the review command/],
      [["draft", "check", QUOTA_DRAFT, "--format", "markdown"], /Unknown format "markdown" for draft; expected text or json/],
    ] as const) {
      const run = cli(root, ...args);
      assert.equal(run.code, 2, args.join(" "));
      assert.equal(run.stdout, "");
      assert.match(run.stderr, message, args.join(" "));
    }

    // A link on the way, out of the project or not, is not followed.
    fs.symlinkSync(path.join(outside, "x"), path.join(root, "src/modules/linked"));
    const linked = draft(root, "create", "src/modules/linked/x.cage.mdx");
    assert.equal(linked.code, 1);
    assert.deepEqual(codes(linked.report), ["E_DRAFT"]);
    assert.match(linked.report.diagnostics[0].message, /src\/modules\/linked is a symbolic link/);
    fs.symlinkSync(path.join(root, MAIL), path.join(root, "src/modules/quota/alias.cage.mdx"));
    assert.deepEqual(codes(draft(root, "create", "src/modules/quota/alias.cage.mdx").report), ["E_DRAFT"]);
    fs.rmSync(path.join(root, "src/modules/quota/alias.cage.mdx"));
    fs.symlinkSync(path.join(outside, "x/x.cage.mdx"), path.join(root, QUOTA_DRAFT));
    assert.deepEqual(codes(draft(root, "activate", QUOTA_DRAFT).report), ["E_DRAFT"]);
    fs.rmSync(path.join(root, QUOTA_DRAFT));
    fs.rmSync(path.join(root, "src/modules/linked"));
    // A document the designs patterns do not take would not be a design.
    assert.deepEqual(codes(draft(root, "create", "docs/notes.cage.mdx").report), ["E_DRAFT"]);
    assert.deepEqual(snapshot(root), before);
    assert.deepEqual(snapshot(outside), outsideBefore);

    // --root and --config: the path counts from the root, the patterns are the given configuration's.
    writeFile(root, "custom.json", JSON.stringify({ version: 1, designs: ["specs/**/*.cage.mdx", "src/**/*.cage.mdx"] }));
    const parent = path.dirname(root);
    const fromParent = (...args: string[]) => JSON.parse(cli(parent, "draft", ...args, "--root", path.basename(root), "--format", "json").stdout) as DraftReport;
    assert.deepEqual(codes(fromParent("create", "specs/billing/billing.cage.mdx")), ["E_DRAFT"]);
    const created = fromParent("create", "specs/billing/billing.cage.mdx", "--config", "custom.json");
    assert.equal(created.status, "created", JSON.stringify(created.diagnostics));
    assert.equal(fromParent("check", "specs/billing/billing.cage.draft.mdx", "--config", "custom.json").status, "valid");
    assert.equal(fromParent("activate", "specs/billing/billing.cage.draft.mdx", "--config", "custom.json").status, "activated");
    assert.ok(fs.existsSync(path.join(root, "specs/billing/billing.cage.mdx")));

    // The text report's next command repeats the options that chose the project.
    const project = ["--root", path.basename(root), "--config", "custom.json"];
    const createdText = textFacts(cli(parent, "draft", "create", "specs/notes/notes.cage.mdx", ...project).stdout);
    assert.equal(createdText.heading, "draft create: written");
    assert.equal(createdText.facts.draft, "specs/notes/notes.cage.draft.mdx (written)");
    assert.equal(createdText.facts.target, "specs/notes/notes.cage.mdx (a new document, not written)");
    assert.equal(createdText.facts.next, `cage draft check specs/notes/notes.cage.draft.mdx ${project.join(" ")}`);
    const checkedText = textFacts(cli(parent, "draft", "check", "specs/notes/notes.cage.draft.mdx", ...project).stdout);
    assert.match(checkedText.heading, /^draft check: valid/);
    assert.equal(checkedText.facts.next, `cage draft activate specs/notes/notes.cage.draft.mdx ${project.join(" ")}`);
    const activatedText = textFacts(cli(parent, "draft", "activate", "specs/notes/notes.cage.draft.mdx", ...project).stdout);
    assert.match(activatedText.heading, /^draft activate: activated/);
    assert.equal(activatedText.facts.draft, "specs/notes/notes.cage.draft.mdx (removed)");
    assert.equal(activatedText.facts.target, "specs/notes/notes.cage.mdx (created with the draft, without its header)");
    assert.equal(activatedText.facts["not checked"], "implementations, tests, reviews");
    assert.equal(activatedText.facts["not recorded"], ".cage/lock.json, .cage/review.json");
    assert.equal(activatedText.facts.next, `cage check ${project.join(" ")}`);
  });

  /** @covers draft-candidate */
  it("checks the candidate with the project's TypeScript, 5 or 6", (t) => {
    for (const [compiler, version] of [["typescript-5", "5.9.3"], ["typescript", "6.0.3"]] as const) {
      const root = designProject(t, { store: mdx(contract("Store", "get(key: string): string;")) });
      fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
      // A copy, not a link: the project's compiler is the one under its own node_modules, wherever the repository's lives.
      fs.cpSync(path.join(repository, "node_modules", compiler), path.join(root, "node_modules/typescript"), { recursive: true, dereference: true });
      const storeDraft = "src/store/store.cage.draft.mdx";
      assert.equal(draft(root, "create", designFile("store")).code, 0);
      editFile(root, storeDraft, (text) => text.replace("get(key: string): string;", "get(key: Missing): string;"));
      const { code, report } = draft(root, "check", storeDraft);
      assert.equal(code, 1);
      assert.deepEqual(report.validation?.typescript, { version, source: "project" });
      const mistake = report.diagnostics.find(({ code: actual }) => actual === "E_TYPESCRIPT");
      assert.deepEqual(mistake && { file: mistake.file, line: mistake.line, column: mistake.column }, { file: storeDraft, ...find(readFile(root, storeDraft), "Missing") });
    }
  });

  /** @covers draft-create draft-activate */
  it("never writes or removes a temporary file it did not create, its own included in the names it picks", (t) => {
    const root = copyFixture(t, "vertical");
    // Files someone left under the names a writer of this process would once have used.
    const foreign = (file: string) => `${path.join(root, file)}.${process.pid}.tmp`;
    for (const file of [QUOTA_DRAFT, QUOTA, ".cage/review.json"]) writeFile(root, path.relative(root, foreign(file)), "someone else's\n");

    assert.equal(draft(root, "create", QUOTA).code, 0);
    editFile(root, QUOTA_DRAFT, (text) => text.replace("Квота визначає", "Квота (v2) визначає"));
    const activated = draft(root, "activate", QUOTA_DRAFT);
    assert.equal(activated.code, 0, JSON.stringify(activated.report.diagnostics));
    assert.match(readFile(root, QUOTA), /Квота \(v2\) визначає/);
    assert.equal(cli(root, "review", "--accept").code, 0);
    for (const file of [QUOTA_DRAFT, QUOTA, ".cage/review.json"]) assert.equal(fs.readFileSync(foreign(file), "utf8"), "someone else's\n");
    // And none of its own is left.
    assert.deepEqual(temporaryFiles(root).sort(), [QUOTA_DRAFT, QUOTA, ".cage/review.json"].map((file) => `${file}.${process.pid}.tmp`).sort());
  });

  /** @covers draft-create draft-activate */
  it("refuses with both files as they were when a write fails before its commit, and leaves no temporary file", (t) => {
    const root = copyFixture(t, "vertical");
    assert.equal(draft(root, "create", QUOTA).code, 0);
    editFile(root, QUOTA_DRAFT, (text) => text.replace("Квота визначає", "Квота (v2) визначає"));
    const before = snapshot(root);
    // The disk fills up while the temporary file is written.
    inject(t, "writeFileSync", (file) => typeof file === "number", "ENOSPC");
    const full = draft(root, "activate", QUOTA_DRAFT);
    assert.equal(full.code, 2);
    assert.equal(full.report.status, "refused");
    assert.deepEqual(codes(full.report), ["E_ENVIRONMENT"]);
    assert.equal(draft(root, "create", "src/modules/billing/billing.cage.mdx").report.status, "refused");
    const text = textFacts(cli(root, "draft", "activate", QUOTA_DRAFT).stdout);
    assert.equal(text.heading, "draft activate: refused (1 error, 1 warning)");
    assert.equal(text.facts.draft, `${QUOTA_DRAFT} (kept)`);
    assert.equal(text.facts.target, `${QUOTA} (unchanged)`);
    t.mock.restoreAll();
    // The rename that would commit fails.
    inject(t, "renameSync", () => true, "EXDEV");
    assert.equal(draft(root, "activate", QUOTA_DRAFT).report.status, "refused");
    t.mock.restoreAll();
    assert.deepEqual(without(snapshot(root), "src/modules/billing"), before);
    assert.equal(fs.existsSync(path.join(root, "src/modules/billing/billing.cage.draft.mdx")), false);
    assert.deepEqual(temporaryFiles(root), []);
  });

  /** @covers draft-create draft-activate */
  it("reports a write as done once it is committed, with the cleanup that failed after it", (t) => {
    const root = copyFixture(t, "vertical");
    const billing = "src/modules/billing/billing.cage.mdx";
    const billingDraft = "src/modules/billing/billing.cage.draft.mdx";
    const ownTemporary = (file: string) => (candidate: unknown) => typeof candidate === "string" && candidate.startsWith(`${path.join(root, file)}.`) && candidate.endsWith(".tmp");

    // create: the draft is linked in place, then its temporary file cannot be removed.
    inject(t, "rmSync", ownTemporary(QUOTA_DRAFT), "EACCES");
    const created = draft(root, "create", QUOTA);
    t.mock.restoreAll();
    assert.equal(created.code, 2);
    assert.equal(created.report.status, "created");
    assert.deepEqual(created.report.diagnostics.map(({ code, file }) => ({ code, file: file && file.replace(/\.\d+\.[0-9a-f]+\.tmp$/, ".tmp") })), [{ code: "E_ENVIRONMENT", file: `${QUOTA_DRAFT}.tmp` }]);
    const draftText = readFile(root, QUOTA_DRAFT);
    assert.ok(draftText.startsWith(`{/* cage draft v1\ntarget: ${QUOTA}\n`));
    assert.deepEqual(temporaryFiles(root).map((file) => readFile(root, file)), [draftText]);
    fs.rmSync(path.join(root, created.report.diagnostics[0].file!));
    fs.rmSync(path.join(root, QUOTA_DRAFT));
    inject(t, "rmSync", ownTemporary(QUOTA_DRAFT), "EACCES");
    const createdText = textFacts(cli(root, "draft", "create", QUOTA).stdout);
    t.mock.restoreAll();
    assert.equal(createdText.heading, "draft create: written (1 error)");
    assert.equal(createdText.facts.draft, `${QUOTA_DRAFT} (written)`);
    for (const file of temporaryFiles(root)) fs.rmSync(path.join(root, file));

    // activate a new document: the design is created, the draft consumed, a temporary file left and said so.
    assert.equal(draft(root, "create", billing).code, 0);
    const content = readFile(root, billingDraft).replace(/^\{\/\*[\s\S]*?\*\/\}\n/, "");
    inject(t, "rmSync", ownTemporary(billing), "EACCES");
    const activated = draft(root, "activate", billingDraft);
    t.mock.restoreAll();
    assert.equal(activated.code, 2);
    assert.equal(activated.report.status, "activated");
    assert.deepEqual(codes(activated.report), ["E_ENVIRONMENT"]);
    assert.equal(readFile(root, billing), content);
    assert.equal(fs.existsSync(path.join(root, billingDraft)), false);
    assert.deepEqual(temporaryFiles(root).map((file) => file.replace(/\.\d+\.[0-9a-f]+\.tmp$/, ".tmp")), [`${billing}.tmp`]);
    for (const file of temporaryFiles(root)) fs.rmSync(path.join(root, file));

    // activate, then the draft itself cannot be removed: the design is active, the draft is said to be left.
    editFile(root, QUOTA_DRAFT, (text) => text.replace("Квота визначає", "Квота (v2) визначає"));
    inject(t, "rmSync", (file) => file === path.join(root, QUOTA_DRAFT), "EACCES");
    const kept = cli(root, "draft", "activate", QUOTA_DRAFT);
    t.mock.restoreAll();
    assert.equal(kept.code, 2);
    const facts = textFacts(kept.stdout);
    assert.match(facts.heading, /^draft activate: activated \(1 error, \d+ warnings?\)$/);
    assert.equal(facts.facts.draft, `${QUOTA_DRAFT} (not removed)`);
    assert.equal(facts.facts.next, "cage check");
    assert.match(readFile(root, QUOTA), /Квота \(v2\) визначає/);
    assert.ok(fs.existsSync(path.join(root, QUOTA_DRAFT)));
  });
});

/** The temporary files under a project, as project paths: what a write left behind. */
function temporaryFiles(root: string): string[] {
  return Object.keys(snapshot(root)).filter((file) => file.endsWith(".tmp"));
}

/** Makes one file system call fail, as a full disk or a permission would, for the paths `matches` picks; the rest pass. */
function inject(t: TestContext, name: "rmSync" | "writeFileSync" | "renameSync", matches: (file: unknown) => boolean, code: string): void {
  const original = fs[name] as (...args: unknown[]) => unknown;
  t.mock.method(fs, name, ((...args: unknown[]) => {
    if (matches(args[0])) throw Object.assign(new Error(`${code}: injected failure`), { code, syscall: name });
    return original(...args);
  }) as never);
}
