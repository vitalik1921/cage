import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { InitReport } from "../src/init.ts";
import { runCli } from "../src/main.ts";
import type { ReviewIndex, ReviewReport } from "../src/review.ts";
import { cli, copyFixture, designProject, editFile, writeFile } from "./helpers.ts";

const SEND_TEST = "src/modules/campaigns/send.test.ts";

/** A project that is its own Git repository: `init` would otherwise write the agent's files to the harness's repository around the scratch directory. */
function repository(t: TestContext): string {
  const root = designProject(t, {});
  const made = spawnSync("git", ["init", "--quiet"], { cwd: root, encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
  return root;
}

/** The CLI with a person at the terminal who gives `answers` in turn, then ends the input. */
function interactive(root: string, answers: readonly string[], ...args: string[]) {
  let stdout = "";
  let stderr = "";
  const asked: string[] = [];
  const queue = [...answers];
  const code = runCli(["init", ...args], {
    cwd: root,
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
    ask: (question) => {
      asked.push(question);
      return queue.shift() ?? null;
    },
  });
  return { code, stdout, stderr, asked };
}

test("init without --agent asks in a terminal, with no default: a blank or unknown answer is asked again", (t) => {
  const root = repository(t);
  const run = interactive(root, ["", "  cursor ", "\u001b[31mred", " Codex "], "--format", "json");
  assert.equal(run.code, 0);
  assert.equal(run.asked.length, 4);
  assert.match(run.stderr, /Which agent should cage hold to the designs here\?/);
  assert.match(run.stderr, /1\) claude[\s\S]*2\) codex[\s\S]*3\) both[\s\S]*4\) none/);
  assert.match(run.stderr, /There is no default; type one of the choices\./);
  assert.match(run.stderr, /"cursor" is not one of the choices\./);
  // A control sequence typed by mistake is shown escaped, not sent to the terminal.
  assert.ok(!run.stderr.includes("\u001b"));
  assert.match(run.stderr, /"\\u001b\[31mred" is not one of the choices\./);
  // The question goes to stderr: stdout stays the report, parseable.
  const report = JSON.parse(run.stdout) as InitReport;
  assert.deepEqual(report.agents, ["codex"]);
  assert.ok(fs.existsSync(path.join(root, ".codex/config.toml")));
  assert.ok(!fs.existsSync(path.join(root, ".claude/settings.json")));

  for (const [answer, agents] of [["1", ["claude"]], ["claude", ["claude"]], ["3", ["claude", "codex"]], ["BOTH", ["claude", "codex"]], ["4", []], ["none", []]] as const) {
    const other = repository(t);
    const chosen = interactive(other, [answer], "--format", "json");
    assert.equal(chosen.code, 0, answer);
    assert.deepEqual((JSON.parse(chosen.stdout) as InitReport).agents, agents, answer);
  }
});

test("init cancelled at its question writes nothing; so does one that gets no choice after five answers", (t) => {
  const root = repository(t);
  const before = fs.readdirSync(root).sort();
  const cancelled = interactive(root, []);
  assert.equal(cancelled.code, 130);
  assert.equal(cancelled.stdout, "");
  assert.match(cancelled.stderr, /cage: init cancelled; nothing was written\.\n$/);
  assert.deepEqual(fs.readdirSync(root).sort(), before);

  const afterBlank = interactive(root, ["", "x"]);
  assert.equal(afterBlank.code, 130);
  assert.deepEqual(fs.readdirSync(root).sort(), before);

  const lost = interactive(root, ["a", "b", "c", "d", "e", "claude"]);
  assert.equal(lost.code, 2);
  assert.equal(lost.asked.length, 5);
  assert.match(lost.stderr, /No agent chosen after 5 answers; nothing was written\. Pass --agent claude, --agent codex or --agent none\./);
  assert.deepEqual(fs.readdirSync(root).sort(), before);
});

test("init without --agent and without a terminal fails and says what to pass; with --agent it asks nothing", (t) => {
  const root = repository(t);
  const before = fs.readdirSync(root).sort();
  const piped = cli(root, "init");
  assert.equal(piped.code, 2);
  assert.equal(piped.stdout, "");
  assert.match(piped.stderr, /asks which one only in a terminal; pass --agent claude, --agent codex \(both may be given\) or --agent none\./);
  assert.deepEqual(fs.readdirSync(root).sort(), before);
  // Usage errors come before the question: nothing is asked for a run that cannot go ahead.
  const wrong = interactive(root, ["claude"], "--test-adapter", "jest");
  assert.equal(wrong.code, 2);
  assert.deepEqual(wrong.asked, []);

  const given = interactive(root, [], "--agent", "none");
  assert.equal(given.code, 0);
  assert.deepEqual(given.asked, []);
  assert.match(given.stdout, /no Stop gate set up/);
});

test("the review packet shows what is collected, what the test text says and what is recorded as separate facts", (t) => {
  const root = copyFixture(t, "vertical");
  const markdown = () => cli(root, "review", "Send").stdout;
  const head = (text: string) => text.slice(0, text.indexOf("\n## "));

  const fresh = head(markdown());
  assert.match(fresh, /^# Send \(src\/modules\/campaigns\)$/m);
  assert.match(fresh, /^fingerprint: sha256:code-v1:[0-9a-f]{64}$/m);
  assert.match(fresh, /^tests: all 4 active$/m);
  assert.match(fresh, /^review: none$/m);
  assert.doesNotMatch(fresh, /pass(ed)?\b|adequate/);
  // Facts only: the reviewer's instruction is the skill's, not the packet's.
  assert.ok(!markdown().includes("You are reviewing"));

  // A verdict for this material is shown as such; one with a weak finding needs a look.
  const json = () => JSON.parse(cli(root, "review", "Send", "--format", "json").stdout) as ReviewReport;
  assert.deepEqual(json().contracts[0].recordedReview, { status: "none", assessments: null, contractAssessments: null });
  const fingerprint = json().contracts[0].fingerprint;
  const findings = ["quota", "limit", "quota-error", "sender-error"].map((invariant, index) => ({
    invariant,
    assessment: index === 0 ? "weak" : "adequate",
    reason: "read the test",
    evidence: `${SEND_TEST}:9`,
    suggestedChange: null,
  }));
  writeFile(root, "verdicts.json", JSON.stringify({ version: 1, verdicts: [{ contract: "Send", fingerprint, findings }] }));
  assert.equal(cli(root, "review", "--record", "verdicts.json").code, 0);
  assert.match(head(markdown()), /^review: current: 3 adequate, 1 weak$/m);
  assert.deepEqual(json().contracts[0].recordedReview, { status: "current", assessments: { adequate: 3, weak: 1, unrelated: 0, "insufficient-context": 0 }, contractAssessments: { adequate: 0, weak: 0, unrelated: 0, "insufficient-context": 0 } });

  // A skipped test is inactive in the packet, and the recorded verdict is for other material now.
  editFile(root, SEND_TEST, (text) => text.replace('it("не передає', 'it.skip("не передає'));
  const changed = markdown();
  assert.match(head(changed), /^tests: 1 of 4 inactive \(skipped, todo, empty or a broken import\); not run by cage$/m);
  assert.match(head(changed), /^review: outdated, 1 part changed, touching 1 of 4 invariants$/m);
  assert.match(changed, /^- tests: src\/modules\/campaigns\/send\.test\.ts; inactive: "не передає повідомлення без квоти" skipped by `\.skip` \(line \d+\)$/m);
  const declarations = json().contracts[0].tests[0].declarations;
  assert.deepEqual(declarations.map(({ status }) => status), ["active", "skipped", "active", "active"]);
  assert.equal(json().contracts[0].recordedReview.status, "outdated");
  // No colour, the same text in a pipe as anywhere: nothing for a terminal to interpret.
  assert.ok(!changed.includes("\u001b"));

  // A broken review file leaves the review status unknown, not "none".
  writeFile(root, ".cage/review.json", "{ nope");
  assert.match(head(markdown()), /^review: not known \(the review file cannot be used\)$/m);
});

test("with every contract reviewed, the default index says so instead of an empty document", (t) => {
  const root = designProject(t, {});
  assert.match(cli(root, "review").stdout, /^# Review index: the designs could not be indexed$/m);
  const vertical = copyFixture(t, "vertical");
  const report = JSON.parse(cli(vertical, "review", "--all", "--format", "json").stdout) as ReviewIndex;
  const verdicts = report.contracts.map((entry) => ({
    contract: entry.contract,
    fingerprint: entry.fingerprint,
    findings: entry.invariants.length === 0 ? [{ invariant: null, assessment: "adequate", reason: "a note", evidence: "x:1", suggestedChange: null }] : entry.invariants.map((id) => ({ invariant: id, assessment: "adequate", reason: "r", evidence: "x:1", suggestedChange: null })),
  }));
  writeFile(vertical, "verdicts.json", JSON.stringify({ version: 1, verdicts }));
  assert.equal(cli(vertical, "review", "--record", "verdicts.json").code, 0);
  assert.match(cli(vertical, "review").stdout, /^# Review index: no contract needs a review$/m);
});

test("format and path options are checked against the command they are given to", (t) => {
  const root = designProject(t, {});
  assert.match(cli(root, "review", "--format", "text").stderr, /Unknown format "text" for the review packet; expected markdown or json\./);
  assert.match(cli(root, "review", "--record", "v.json", "--format", "markdown").stderr, /Unknown format "markdown" for review --record; expected text or json\./);
  assert.match(cli(root, "check", "--format", "markdown").stderr, /Unknown format "markdown" for check; expected text or json\./);
  assert.match(cli(root, "check", "--root", "").stderr, /--root needs the path of the project directory\./);
  assert.match(cli(root, "check", "--config", " ").stderr, /--config needs the path of a configuration file\./);
  for (const args of [["review", "--format", "text"], ["check", "--root", ""]]) assert.equal(cli(root, ...args).code, 2);
});
