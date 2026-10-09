import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReviewReport } from "../src/review.ts";
import { formatReviewMarkdown } from "../src/review.ts";
import { cli, copyFixture, editFile, readFile, writeFile } from "./helpers.ts";

const source = "src/modules/campaigns/send-service.ts";
const tests = "src/modules/campaigns/send.test.ts";
const design = "src/modules/campaigns/campaigns.cage.mdx";
const helper = "src/modules/mail/callback-sender.ts";
const packet = (root: string, mode: string) => JSON.parse(cli(root, "review", "Send", "--files", mode, "--format", "json").stdout) as ReviewReport;
const included = (report: ReviewReport) => [...report.files.map((file) => file.text), ...report.excerpts.flatMap((excerpt) => excerpt.pieces.map((piece) => piece.text))].join("\n");

/** @tests Cli
 * @covers review-packet review-touched */
test("context includes requirements, implementation, affected tests and helpers without altering review identity", (t) => {
  const root = copyFixture(t, "vertical");
  assert.equal(cli(root, "review", "--accept").code, 0);
  editFile(root, source, (text) => text.replace('return "sent";', 'return "limited";'));
  const changed = packet(root, "changed");
  const context = packet(root, "context");
  assert.equal(context.included, "context");
  assert.equal(context.complete, true);
  for (const key of ["fingerprint", "invariants", "changed", "touched", "recordedReview"] as const) assert.deepEqual(context.contracts[0][key], changed.contracts[0][key]);
  assert.equal(context.files.find((file) => file.path === design)?.text, readFile(root, design));
  assert.equal(context.files.find((file) => file.path === helper)?.text, readFile(root, helper));
  assert.ok(context.files.some((file) => file.path === "src/modules/quota/quota.cage.mdx"));
  assert.ok(included(context).includes('assert.equal(await pending, "sent")'));
  assert.ok(included(context).includes('return "limited";'));
  assert.ok(included(context).includes("await assert.rejects"));
  assert.ok(!included(changed).includes("await assert.rejects"));
  assert.ok(!context.excerpts.some((excerpt) => context.files.some((file) => file.path === excerpt.file)));
});

/** @tests Cli
 * @covers review-packet review-touched */
test("a test-only change selects affected tests with their imports and retains full previous findings", (t) => {
  const root = copyFixture(t, "vertical");
  const initial = packet(root, "changed").contracts[0];
  const finding = (invariant: string | null) => ({ invariant, assessment: "adequate", reason: "First sentence. Second sentence contains essential context.", evidence: `${tests}:9`, suggestedChange: "Keep the deferred permission setup." });
  writeFile(root, "verdict.json", JSON.stringify({ version: 1, verdicts: [{ contract: "Send", fingerprint: initial.fingerprint, findings: [...initial.invariants.map(({ id }) => finding(id)), finding(null)] }] }));
  assert.equal(cli(root, "review", "--record", "verdict.json").code, 0);
  editFile(root, tests, (text) => text.replace('assert.equal(await service.run("a", "hello"), "limited");', 'assert.equal(await service.run("a", "hello"), "sent");'));
  const report = packet(root, "context");
  assert.deepEqual(report.contracts[0].touched, ["limit"]);
  const testText = report.excerpts.filter((excerpt) => excerpt.file === tests).flatMap((excerpt) => excerpt.pieces.map((piece) => piece.text)).join("\n");
  assert.ok(testText.includes('import { CallbackSender }'));
  assert.ok(testText.includes('it("не передає повідомлення без квоти"'));
  assert.ok(!testText.includes('it("передає помилку транспорту"'));
  assert.ok(included(report).includes("export class SendService"));
  const markdown = cli(root, "review", "Send", "--files", "context").stdout;
  assert.match(markdown, /Second sentence contains essential context/);
  assert.match(markdown, /suggested change: Keep the deferred permission setup/);
  assert.match(markdown, /previous review note: adequate: First sentence\. Second sentence contains essential context/);
  assert.match(markdown, /tests: all 4 active; not run by cage/);
});

/** @tests Cli
 * @covers review-packet */
test("context names imports beyond a test helper's contract boundary", (t) => {
  const root = copyFixture(t, "vertical");
  const dependency = "src/modules/mail/deliver.ts";
  writeFile(root, dependency, "export const deliverText = (text: string) => text;\n");
  editFile(root, helper, (text) => 'import { deliverText } from "./deliver.ts";\n' + text.replace("this.deliver(text)", "this.deliver(deliverText(text))"));
  const report = packet(root, "context");
  assert.equal(report.complete, true);
  assert.ok(report.contextGaps?.some((gap) => gap.contract === "Send" && gap.file === dependency && gap.reason === "helper-import"));
  assert.ok(!report.files.some((file) => file.path === dependency));
  assert.ok(!report.excerpts.some((excerpt) => excerpt.file === dependency));
  const markdown = cli(root, "review", "Send", "--files", "context").stdout;
  assert.match(markdown, /Not included for Send: .*imported by a test helper/);
  assert.ok(markdown.includes(dependency));
  assert.equal(packet(root, "changed").contextGaps, undefined);
});

/** @tests Cli
 * @covers review-packet */
test("context Markdown emits the exact union of source lines once and keeps JSON part provenance", (t) => {
  const root = copyFixture(t, "vertical");
  const report = packet(root, "context");
  const before = structuredClone(report);
  // Exercise overlap between different parts as well as a whole file superseding a slice.
  report.excerpts.push({ ...structuredClone(report.excerpts[0]), part: "another consumer" });
  const whole = report.files[0];
  report.excerpts.push({ file: whole.path, part: "already present whole", pieces: [{ startLine: 1, endLine: 1, text: whole.text.split("\n")[0] }] });
  const frozen = structuredClone(report);
  const markdown = formatReviewMarkdown(report);
  assert.deepEqual(report, frozen);
  assert.deepEqual(report.contracts, before.contracts);
  const expected = new Map<string, string>();
  for (const file of report.files) file.text.replace(/\n$/, "").split("\n").forEach((text, index) => expected.set(`${file.path}:${index + 1}`, text));
  for (const excerpt of report.excerpts) for (const piece of excerpt.pieces) {
    const text = piece.text.split("\n");
    for (let line = piece.startLine; line <= piece.endLine; line++) expected.set(`${excerpt.file}:${line}`, text[line - piece.startLine]);
  }
  const paths = new Map([...markdown.matchAll(/^(F\d+) (".*")$/gm)].map((match) => [match[1], JSON.parse(match[2]) as string]));
  const actual = new Map<string, string>();
  let file = "";
  for (const line of markdown.split("\n")) {
    const header = /^### (F\d+)(?=:| \()/.exec(line);
    if (header) file = paths.get(header[1])!;
    const source = /^\s*(\d+) \| (.*)$/.exec(line);
    if (!source) continue;
    const key = `${file}:${source[1]}`;
    assert.ok(!actual.has(key), `Repeated source line: ${key}`);
    actual.set(key, source[2]);
  }
  assert.deepEqual([...actual].sort(), [...expected].sort());
});
