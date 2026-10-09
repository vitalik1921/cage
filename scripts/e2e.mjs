// Builds and packs the package, installs the tarball into scratch projects outside the repository and drives the
// installed `cage` through what the review of 2026-10-05 found: hook commands with paths a shell or TOML would
// misread, hooks and rules that only look like cage's, review material behind a link out of the project, setup
// around tests in blocks and loops, dependencies that cannot be read, incomplete verdicts, value imports of types,
// and the formats of review. Every step asserts; the evidence goes to test/.tmp/e2e-evidence/.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repository = path.resolve(import.meta.dirname, "..");
const evidence = path.join(repository, "test/.tmp/e2e-evidence");
fs.rmSync(evidence, { recursive: true, force: true });
fs.mkdirSync(evidence, { recursive: true });
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cage-e2e-")));
const passed = [];
const log = (name, text) => fs.writeFileSync(path.join(evidence, `${name}.txt`), text);
const pass = (name, detail) => {
  passed.push(name);
  console.log(`PASS ${name}${detail ? `: ${detail}` : ""}`);
};
const sh = (command, args, options = {}) => spawnSync(command, args, { encoding: "utf8", ...options });

try {
  // ---- The package as npm ships it, installed once; every project below gets a copy of that install.
  execFileSync("npm", ["run", "build", "--silent"], { cwd: repository, stdio: "inherit" });
  const tarball = path.join(scratch, execFileSync("npm", ["pack", "--pack-destination", scratch, "--silent"], { cwd: repository, encoding: "utf8" }).trim().split("\n").pop());
  const base = path.join(scratch, "base");
  fs.cpSync(path.join(repository, "test/fixtures/vertical"), base, { recursive: true });
  const types = JSON.parse(fs.readFileSync(path.join(repository, "package.json"), "utf8")).devDependencies["@types/node"];
  execFileSync("npm", ["install", "--silent", "--no-audit", "--no-fund", "--no-package-lock", tarball, `@types/node@${types}`], { cwd: base, stdio: "inherit" });
  const probe = path.join(scratch, "print-node.cjs");
  fs.writeFileSync(probe, "process.stderr.write(`node ${process.version} ${process.execPath}\\n`);\n");
  const runtime = sh(path.join(base, "node_modules/.bin/cage"), ["--version"], { cwd: base, env: { ...process.env, NODE_OPTIONS: `--require=${probe}` } });
  log("00-runtime", `tarball ${path.basename(tarball)}\ncage --version ${runtime.stdout}installed bin runs on: ${runtime.stderr}scratch ${scratch}\n`);
  assert.match(runtime.stderr, /^node v26\./m, runtime.stderr);
  pass("pack and install", `${path.basename(tarball)}, bin on ${runtime.stderr.trim()}`);

  const project = (name, from = base) => {
    const root = path.join(scratch, name);
    fs.cpSync(from, root, { recursive: true, verbatimSymlinks: true });
    assert.equal(sh("git", ["init", "--quiet"], { cwd: root }).status, 0);
    return root;
  };
  const cage = (root, ...args) => sh(path.join(root, "node_modules/.bin/cage"), args, { cwd: root, input: "" });
  const json = (run) => JSON.parse(run.stdout);

  // ---- 1: paths with $, backticks, quotes and apostrophes are data in both hooks.
  const SPECIAL = `we$HOME $(touch SUBST-RAN) \`touch TICK-RAN\` "dq" it's; a&b`;
  const repo = path.join(scratch, "special");
  fs.mkdirSync(repo);
  assert.equal(sh("git", ["init", "--quiet"], { cwd: repo }).status, 0);
  const special = path.join(repo, "apps", SPECIAL);
  // No design yet: the gate passes such a project, so a hook that runs is a hook that reached it.
  fs.mkdirSync(special, { recursive: true });
  fs.writeFileSync(path.join(special, "package.json"), JSON.stringify({ name: "special", private: true, type: "module" }));
  fs.cpSync(path.join(base, "node_modules"), path.join(special, "node_modules"), { recursive: true, verbatimSymlinks: true });
  const init = cage(special, "init", "--agent", "claude", "--agent", "codex", "--format", "json");
  assert.equal(init.status, 0, init.stderr);
  assert.deepEqual(json(init).diagnostics, []);
  const claudeCommand = JSON.parse(fs.readFileSync(path.join(repo, ".claude/settings.json"), "utf8")).hooks.Stop[0].hooks[0].command;
  const tomlLine = fs.readFileSync(path.join(repo, ".codex/config.toml"), "utf8").split("\n").find((line) => line.startsWith("command = "));
  const codexCommand = JSON.parse(tomlLine.slice("command = ".length));
  const claudeRun = sh("/bin/sh", ["-c", claudeCommand], { cwd: repo, env: { ...process.env, CLAUDE_PROJECT_DIR: repo }, input: "{}" });
  const codexRun = sh("/bin/sh", ["-c", codexCommand], { cwd: repo, input: "{}" });
  const markers = ["SUBST-RAN", "TICK-RAN"].filter((marker) => [scratch, repo, special].some((where) => fs.existsSync(path.join(where, marker))));
  const rerun = json(cage(special, "init", "--agent", "claude", "--agent", "codex", "--format", "json"));
  log("10-special-path-hooks", [`project dir: apps/${SPECIAL}`, `claude command: ${claudeCommand}`, `codex line: ${tomlLine}`, `claude hook exit ${claudeRun.status}: ${claudeRun.stderr}`, `codex hook exit ${codexRun.status}: ${codexRun.stderr}`, `markers found: ${JSON.stringify(markers)}`, `rerun: ${JSON.stringify(rerun.files)}`].join("\n"));
  assert.equal(claudeRun.status, 0, claudeRun.stderr);
  assert.equal(codexRun.status, 0, codexRun.stderr);
  assert.match(claudeRun.stderr, /^cage gate: no \*\.cage\.mdx design yet/);
  assert.deepEqual(markers, []);
  assert.ok(rerun.files.every((file) => file.status === "kept"), JSON.stringify(rerun.files));
  pass("1 special-character paths", "both hooks run the installed gate on the right project; no substitution ran; TOML string decodes; rerun keeps all");

  // ---- 1, as the CLI review reproduced it: `apps/$(touch injected-marker)` for Claude, `apps/o'hare` for Codex, run by sh and zsh.
  const exact = [];
  for (const [agent, PROJECT] of [["claude", "apps/$(touch injected-marker)"], ["codex", "apps/o'hare"]]) {
    const repo = path.join(scratch, `exact-${agent}`);
    fs.mkdirSync(path.join(repo, PROJECT), { recursive: true });
    assert.equal(sh("git", ["init", "--quiet"], { cwd: repo }).status, 0);
    fs.cpSync(path.join(base, "node_modules"), path.join(repo, "node_modules"), { recursive: true, verbatimSymlinks: true });
    // cage installed at the repository root, run from the project, as in the review.
    const run = sh(path.join(repo, "node_modules/.bin/cage"), ["init", "--agent", agent], { cwd: path.join(repo, PROJECT), input: "" });
    assert.equal(run.status, 0, `${run.stderr}${run.error ?? ""}`);
    const command =
      agent === "claude"
        ? JSON.parse(fs.readFileSync(path.join(repo, ".claude/settings.json"), "utf8")).hooks.Stop[0].hooks[0].command
        : JSON.parse(fs.readFileSync(path.join(repo, ".codex/config.toml"), "utf8").split("\n").find((line) => line.startsWith("command = ")).slice("command = ".length));
    for (const shell of ["/bin/sh", "/bin/zsh"].filter((candidate) => fs.existsSync(candidate))) {
      const hook = sh(shell, ["-c", command], { cwd: repo, env: { ...process.env, CLAUDE_PROJECT_DIR: repo }, input: '{"session_id":"e2e-quote","stop_hook_active":false}\n' });
      const marker = fs.existsSync(path.join(repo, "injected-marker")) || fs.existsSync(path.join(repo, "apps", "injected-marker"));
      exact.push(`${agent} ${shell}: ${command}\n  exit ${hook.status}; marker_created=${marker ? "yes" : "no"}; ${hook.stderr.trim()}`);
      assert.equal(hook.status, 0, hook.stderr);
      assert.match(hook.stderr, /^cage gate: no \*\.cage\.mdx design yet/);
      assert.equal(marker, false);
    }
    if (agent === "codex") exact.push(fs.readFileSync(path.join(repo, ".codex/config.toml"), "utf8"));
  }
  log("11-review-exact-hooks", exact.join("\n"));
  pass("1 review's exact paths", "apps/$(touch injected-marker) and apps/o'hare: the installed gate runs under sh and zsh, marker_created=no");

  // ---- 7: a hook that only mentions cage gate.
  const fake = project("fake-hook");
  fs.mkdirSync(path.join(fake, ".claude"));
  fs.writeFileSync(path.join(fake, ".claude/settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: 'echo cage gate --root "$CLAUDE_PROJECT_DIR/."' }] }] } }));
  const fakeInit = json(cage(fake, "init", "--agent", "claude", "--format", "json"));
  const commands = JSON.parse(fs.readFileSync(path.join(fake, ".claude/settings.json"), "utf8")).hooks.Stop.map((group) => group.hooks[0].command);
  log("20-fake-hook", `${JSON.stringify(fakeInit, null, 2)}\n${JSON.stringify(commands, null, 2)}`);
  assert.equal(commands.length, 2);
  assert.equal(commands[0], 'echo cage gate --root "$CLAUDE_PROJECT_DIR/."');
  assert.deepEqual(fakeInit.diagnostics.map(({ code }) => code), ["W_GATE_COMMAND"]);
  assert.equal(json(cage(fake, "init", "--agent", "claude", "--format", "json")).files.find((file) => file.path === ".claude/settings.json").status, "kept");
  pass("7 fake echo hook", "kept, the real gate added beside it, W_GATE_COMMAND; second run keeps");

  // ---- 8: a mention of cage check is not the rules.
  const rules = project("rules");
  fs.writeFileSync(path.join(rules, "CLAUDE.md"), "# Our project\n\nCI runs `cage check` on every push.\n");
  assert.equal(cage(rules, "init", "--agent", "claude").status, 0);
  const withRules = fs.readFileSync(path.join(rules, "CLAUDE.md"), "utf8");
  fs.writeFileSync(path.join(rules, "CLAUDE.md"), withRules.replace("## Contract harness", "## Our contract rules"));
  const edited = fs.readFileSync(path.join(rules, "CLAUDE.md"), "utf8");
  assert.equal(cage(rules, "init", "--agent", "claude").status, 0);
  log("30-rules-marker", fs.readFileSync(path.join(rules, "CLAUDE.md"), "utf8"));
  assert.ok(withRules.startsWith("# Our project\n\nCI runs `cage check` on every push.\n\n<!-- cage:rules -->\n## Contract harness\n"));
  assert.equal(fs.readFileSync(path.join(rules, "CLAUDE.md"), "utf8"), edited);
  pass("8 rules marker", "rules appended behind the marker; an edited section is kept on the next run");

  // ---- The review loop on the fixture: reviews required.
  const loop = project("review");
  assert.equal(cage(loop, "init", "--agent", "none").status, 0);
  const config = JSON.parse(fs.readFileSync(path.join(loop, ".cage/config.json"), "utf8"));
  fs.writeFileSync(path.join(loop, ".cage/config.json"), JSON.stringify({ ...config, review: "require" }, null, 2));
  const QUOTA = "src/modules/quota";
  const TESTS = `${QUOTA}/quota.test.ts`;
  const packet = (name = "Quota") => json(cage(loop, "review", name, "--format", "json"));
  const finding = (invariant, extra = {}) => ({ invariant, assessment: "adequate", reason: "E2E fixture verdict; not a real review.", evidence: `${TESTS}:9`, suggestedChange: null, ...extra });
  const recordQuota = (findings, fingerprint = packet().contracts[0].fingerprint) => {
    fs.writeFileSync(path.join(loop, "verdicts.json"), JSON.stringify({ version: 1, verdicts: [{ contract: "Quota", fingerprint, findings }] }));
    return cage(loop, "review", "--record", "verdicts.json");
  };
  const quotaFindings = () => packet().contracts[0].invariants.map(({ id }) => finding(id));
  const reviewFile = path.join(loop, ".cage/review.json");

  // ---- 5: incomplete verdicts are refused, the review file unchanged.
  assert.equal(recordQuota(quotaFindings()).status, 0);
  const recorded = fs.readFileSync(reviewFile);
  const refusals = [];
  for (const [name, change] of [
    ["blank reason", (findings) => [{ ...findings[0], reason: "  " }, ...findings.slice(1)]],
    ["null evidence on adequate", (findings) => [{ ...findings[0], evidence: null }, ...findings.slice(1)]],
    ["blank evidence on insufficient-context", (findings) => [{ ...findings[0], assessment: "insufficient-context", evidence: "" }, ...findings.slice(1)]],
    ["contract-level note without evidence", (findings) => [...findings, finding(null, { evidence: null })]],
  ]) {
    const run = recordQuota(change(quotaFindings()));
    refusals.push(`${name}: exit ${run.status}\n${run.stdout}`);
    assert.equal(run.status, 1, run.stdout);
    assert.match(run.stdout, /E_REVIEW_VERDICT/);
    assert.deepEqual(fs.readFileSync(reviewFile), recorded);
  }
  // As the source review sent it: every contract, reason "" and evidence null. The index names every contract with its invariants.
  const all = json(cage(loop, "review", "--all", "--format", "json")).contracts;
  fs.writeFileSync(
    path.join(loop, "empty.json"),
    JSON.stringify({ version: 1, verdicts: all.map(({ contract, fingerprint, invariants }) => ({ contract, fingerprint, findings: (invariants.length > 0 ? invariants : [null]).map((id) => ({ invariant: id, assessment: "adequate", reason: "", evidence: null, suggestedChange: null })) })) }),
  );
  const empty = cage(loop, "review", "--record", "empty.json");
  refusals.push(`all contracts with reason "" and evidence null: exit ${empty.status}\n${empty.stdout}`);
  assert.equal(empty.status, 1);
  assert.equal((empty.stdout.match(/E_REVIEW_VERDICT/g) ?? []).length, 2 * all.length);
  assert.deepEqual(fs.readFileSync(reviewFile), recorded);
  assert.equal(recordQuota([{ ...quotaFindings()[0], assessment: "insufficient-context", evidence: null }, ...quotaFindings().slice(1)]).status, 0);
  log("40-verdict-rules", refusals.join("\n"));
  pass("5 complete verdicts", "blank reason, null/blank evidence and an evidence-less contract note refused; review.json byte-identical; insufficient-context with null accepted");

  // File pragmas outside a selected declaration must stale its review and be visible to reviewers.
  const pragmaFile = path.join(loop, QUOTA, "memory-quota.ts");
  const withoutPragma = fs.readFileSync(pragmaFile, "utf8");
  const unused = "const unrelatedHeader = 1;\n";
  fs.writeFileSync(pragmaFile, unused + withoutPragma);
  assert.equal(recordQuota(quotaFindings()).status, 0);
  fs.writeFileSync(pragmaFile, `// Explanation.\n${unused}${withoutPragma}`);
  assert.equal(packet().contracts[0].recordedReview.status, "current");
  fs.writeFileSync(pragmaFile, `// @ts-nocheck\n${unused}${withoutPragma}`);
  const pragmaPacket = packet();
  assert.equal(pragmaPacket.contracts[0].recordedReview.status, "outdated");
  const pragmaExcerpt = pragmaPacket.excerpts.find(({ file }) => file === `${QUOTA}/memory-quota.ts`);
  assert.ok(pragmaExcerpt.pieces.some(({ startLine, text }) => startLine === 1 && text.includes("// @ts-nocheck")));
  assert.match(cage(loop, "review", "Quota").stdout, /\/\/ @ts-nocheck/);
  assert.equal(recordQuota(quotaFindings()).status, 0);
  fs.writeFileSync(pragmaFile, `${unused}// @ts-nocheck\n${withoutPragma}`);
  assert.equal(packet().contracts[0].recordedReview.status, "outdated");
  log("41-file-pragmas", JSON.stringify(pragmaPacket, null, 2));
  fs.writeFileSync(pragmaFile, withoutPragma);
  assert.equal(recordQuota(quotaFindings()).status, 0);
  pass("file pragma freshness and excerpts", "ordinary prose stays current; adding or moving @ts-nocheck invalidates; default JSON and Markdown include the directive");

  // ---- 2: a link out of the project, with preserveSymlinks: the sentinel is never read.
  const outside = path.join(scratch, "outside");
  fs.mkdirSync(outside);
  const SENTINEL = "SENTINEL-OUTSIDE-7731";
  fs.writeFileSync(path.join(outside, "secret.ts"), `export const SECRET = "${SENTINEL}";\n`);
  const testText = fs.readFileSync(path.join(loop, TESTS), "utf8");
  // As the source review reproduced it: `leak.ts` links out, the test imports it, the tsconfig is the fixture's own.
  fs.symlinkSync(path.join(outside, "secret.ts"), path.join(loop, QUOTA, "leak.ts"));
  fs.writeFileSync(path.join(loop, TESTS), testText.replace('import { MemoryQuota } from "./memory-quota.ts";', 'import { MemoryQuota } from "./memory-quota.ts";\nimport { SECRET } from "./leak.ts";\nvoid SECRET;'));
  const leakJson = cage(loop, "review", "Quota", "--format", "json");
  const leak = json(leakJson).contracts[0];
  log("49-outside-link-review-case", `exit ${leakJson.status}\nsentinel in packet: ${leakJson.stdout.includes(SENTINEL)}\nhelpers ${JSON.stringify(leak.helpers)}\nfingerprinted ${JSON.stringify(leak.fingerprinted)}\n${JSON.stringify(leak.diagnostics.filter(({ code }) => code.includes("OUTSIDE") || code.includes("SCOPE")), null, 2)}`);
  assert.ok(!leakJson.stdout.includes(SENTINEL) && !cage(loop, "review", "Quota").stdout.includes(SENTINEL));
  assert.ok(!leak.helpers.includes(`${QUOTA}/leak.ts`) && !leak.fingerprinted.includes(`${QUOTA}/leak.ts`));
  assert.ok(leak.diagnostics.some(({ code, file }) => code === "W_OUTSIDE_ROOT" && file === `${QUOTA}/leak.ts`));
  fs.rmSync(path.join(loop, QUOTA, "leak.ts"));

  fs.symlinkSync(path.join(outside, "secret.ts"), path.join(loop, QUOTA, "linked.ts"));
  fs.writeFileSync(path.join(loop, TESTS), testText.replace('import { MemoryQuota } from "./memory-quota.ts";', 'import { MemoryQuota } from "./memory-quota.ts";\nimport { SECRET } from "./linked.ts";\nvoid SECRET;'));
  const implementation = path.join(loop, QUOTA, "memory-quota.ts");
  const implementationText = fs.readFileSync(implementation, "utf8");
  fs.writeFileSync(implementation, `import { SECRET } from "./linked.ts";\nvoid SECRET;\n${implementationText}`);
  const tsconfig = JSON.parse(fs.readFileSync(path.join(loop, "tsconfig.json"), "utf8"));
  fs.writeFileSync(path.join(loop, "tsconfig.json"), JSON.stringify({ ...tsconfig, compilerOptions: { ...tsconfig.compilerOptions, preserveSymlinks: true } }));
  const linkedJson = cage(loop, "review", "Quota", "--format", "json");
  const linkedMarkdown = cage(loop, "review", "Quota");
  const linked = json(linkedJson).contracts[0];
  assert.equal(recordQuota(quotaFindings(), linked.fingerprint).status, 0);
  const outputs = [linkedJson.stdout, linkedJson.stderr, linkedMarkdown.stdout, linkedMarkdown.stderr, fs.readFileSync(reviewFile, "utf8"), cage(loop, "check", "--format", "json").stdout];
  fs.chmodSync(path.join(outside, "secret.ts"), 0o000);
  const unopened = json(cage(loop, "review", "Quota", "--format", "json")).contracts[0];
  fs.chmodSync(path.join(outside, "secret.ts"), 0o644);
  log("50-outside-link", [`diagnostics: ${JSON.stringify(linked.diagnostics, null, 2)}`, `helpers: ${JSON.stringify(linked.helpers)}`, `fingerprinted: ${JSON.stringify(linked.fingerprinted)}`, `sentinel in any output: ${outputs.some((text) => text.includes(SENTINEL))}`, `with the outside file unreadable: ${JSON.stringify(unopened.diagnostics.map(({ code }) => code))}`].join("\n"));
  assert.ok(!outputs.some((text) => text.includes(SENTINEL)));
  assert.ok(linked.diagnostics.some(({ code }) => code === "W_OUTSIDE_ROOT"));
  // Neither the packet nor check reports configured fingerprint bounds.
  assert.ok(!linked.diagnostics.some(({ code }) => code.endsWith("REVIEW_SCOPE_LIMIT")));
  // Reviews are required here; the boundary is still not a scope error.
  assert.ok(!json(cage(loop, "check", "--format", "json")).diagnostics.some(({ code }) => code.endsWith("REVIEW_SCOPE_LIMIT")));
  assert.ok(!unopened.diagnostics.some(({ code }) => code === "E_ENVIRONMENT"));
  fs.writeFileSync(path.join(loop, TESTS), testText);
  fs.writeFileSync(implementation, implementationText);
  fs.writeFileSync(path.join(loop, "tsconfig.json"), JSON.stringify(tsconfig));
  fs.rmSync(path.join(loop, QUOTA, "linked.ts"));
  pass("2 link out of the project", "review's leak.ts case and a preserveSymlinks case: sentinel absent from packet JSON/Markdown, review.json and check; W_OUTSIDE_ROOT, no scope-limit diagnostics; unreadable target never opened");

  // ---- 3: setup in a block and a loop around a test.
  fs.writeFileSync(
    path.join(loop, TESTS),
    [
      'import assert from "node:assert/strict";',
      'import { describe, it } from "node:test";',
      'import { MemoryQuota } from "./memory-quota.ts";',
      "",
      "/** @tests Quota */",
      'describe("MemoryQuota", () => {',
      "  for (const left of [0]) {",
      '    const unknown = "nobody";',
      "    /** @covers empty */",
      '    it("refuses", async () => {',
      "      const quota = new MemoryQuota({ a: left });",
      '      assert.equal(await quota.take("a"), false);',
      "      assert.equal(await quota.take(unknown), false);",
      "    });",
      "  }",
      "  {",
      "    const start = 1;",
      "    const expected = false;",
      "    /** @covers consume accounts race */",
      '    it("takes one", async () => {',
      "      const quota = new MemoryQuota({ a: start, b: 1 });",
      '      assert.equal(await quota.take("a"), true);',
      '      assert.equal(await quota.take("a"), expected);',
      "    });",
      "  }",
      "});",
      "",
    ].join("\n"),
  );
  assert.equal(recordQuota(quotaFindings()).status, 0);
  const stale = [];
  for (const [from, to, title] of [
    ["for (const left of [0])", "for (const left of [1])", "refuses"],
    ["const start = 1;", "const start = 2;", "takes one"],
    // The source review's case: the expected value of an assertion, inverted in the block around the test.
    ["const expected = false;", "const expected = true;", "takes one"],
  ]) {
    const before = packet().contracts[0].fingerprint;
    fs.writeFileSync(path.join(loop, TESTS), fs.readFileSync(path.join(loop, TESTS), "utf8").replace(from, to));
    const check = cage(loop, "check");
    const after = packet().contracts[0].fingerprint;
    stale.push(`${from} -> ${to}: fingerprint ${before} -> ${after}\n${check.stdout.split("\n").filter((line) => line.includes("REVIEW_STALE")).join("\n")}`);
    assert.notEqual(after, before);
    assert.equal(check.status, 1);
    // The code heads the diagnostic; the changed parts follow one a line.
    assert.match(check.stdout, new RegExp(`E_REVIEW_STALE: Quota \\([^\\n]+\\)\\n(?:[^\\n]*\\n)*?  - test "${title}"`));
    assert.equal(recordQuota(quotaFindings()).status, 0);
  }
  log("60-block-loop-setup", stale.join("\n"));
  fs.writeFileSync(path.join(loop, TESTS), testText);
  assert.equal(recordQuota(quotaFindings()).status, 0);
  pass("3 block and loop setup", "a loop header and a block variable each make their test's review outdated");

  // ---- 4: a dependency the review cannot read.
  // As the source review reproduced it: the test imports a readable test-support/a.ts, which imports test-support/b.ts.
  fs.mkdirSync(path.join(loop, "test-support"));
  fs.writeFileSync(path.join(loop, "test-support/a.ts"), 'import { seed } from "./b.ts";\nexport const initial = () => ({ a: seed });\n');
  fs.writeFileSync(path.join(loop, "test-support/b.ts"), "export const seed = 1;\n");
  fs.writeFileSync(path.join(loop, TESTS), testText.replace('import { MemoryQuota } from "./memory-quota.ts";', 'import { MemoryQuota } from "./memory-quota.ts";\nimport { initial } from "../../../test-support/a.ts";\nvoid initial;'));
  assert.equal(recordQuota(quotaFindings()).status, 0);
  const beforeUnreadable = fs.readFileSync(reviewFile);
  fs.chmodSync(path.join(loop, "test-support/b.ts"), 0o000);
  const holed = cage(loop, "review", "Quota", "--format", "json");
  const refused = recordQuota(quotaFindings(), json(holed).contracts[0].fingerprint);
  fs.chmodSync(path.join(loop, "test-support/b.ts"), 0o644);
  log("70-unreadable-dependency", `review exit ${holed.status}, ok ${json(holed).ok}, complete ${json(holed).complete}\n${JSON.stringify(json(holed).contracts[0].diagnostics.filter(({ code }) => code === "E_ENVIRONMENT"), null, 2)}\nrecord exit ${refused.status}\n${refused.stdout}`);
  assert.equal(holed.status, 2);
  assert.equal(json(holed).complete, false);
  assert.ok(json(holed).contracts[0].diagnostics.some(({ code, file }) => code === "E_ENVIRONMENT" && file === "test-support/b.ts"));
  assert.equal(refused.status, 2);
  assert.deepEqual(fs.readFileSync(reviewFile), beforeUnreadable);
  fs.writeFileSync(path.join(loop, TESTS), testText);
  fs.writeFileSync(path.join(loop, "tsconfig.json"), JSON.stringify(tsconfig));
  pass("4 unreadable dependency", "packet E_ENVIRONMENT, complete false, exit 2; record exit 2; review.json byte-identical");

  // ---- 6: a value import of a type, under node:test.
  fs.writeFileSync(path.join(loop, QUOTA, "shapes.ts"), "export interface Shape { size: number }\nexport class Klass {}\nexport type { Klass as OnlyType };\n");
  const typeCases = [];
  fs.writeFileSync(path.join(loop, QUOTA, "type-only.ts"), "export type MissingRuntime = { size: number };\n");
  fs.writeFileSync(path.join(loop, QUOTA, "typestar.ts"), 'export type * from "./shapes.ts";\n');
  for (const [imports, expected] of [
    // The source review's case.
    ['import { MissingRuntime } from "./type-only.ts";', "broken"],
    ['import { Shape } from "./shapes.ts";', "broken"],
    ['import { OnlyType } from "./shapes.ts";', "broken"],
    ['import { Klass } from "./typestar.ts";', "broken"],
    ['import type { Shape } from "./shapes.ts";', "active"],
    ['import { type Shape, Klass } from "./shapes.ts";', "active"],
  ]) {
    fs.writeFileSync(path.join(loop, TESTS), testText.replace('import { MemoryQuota } from "./memory-quota.ts";', `import { MemoryQuota } from "./memory-quota.ts";\n${imports}`));
    const check = json(cage(loop, "check", "--format", "json"));
    const inactive = check.diagnostics.filter(({ code }) => code === "E_TEST_INACTIVE");
    typeCases.push(`${imports} -> activeTestDeclarations ${check.counts.activeTestDeclarations}; ${inactive[0]?.message ?? "no E_TEST_INACTIVE"}`);
    if (expected === "broken") assert.ok(inactive.length > 0 && /only as a type/.test(inactive[0].message), imports);
    else assert.equal(inactive.length, 0, imports);
  }
  fs.writeFileSync(path.join(loop, TESTS), testText);
  log("80-type-only-imports", typeCases.join("\n"));
  pass("6 value import of a type", "interface and `export type` re-export broken under node:test; `import type` and `{ type X }` active");

  // ---- 6, as the source acceptance reproduced it: Vitest, default options, a named alias re-export of an interface used as a value.
  const vitest = project("vitest-alias");
  fs.mkdirSync(path.join(vitest, "node_modules/vitest"), { recursive: true });
  fs.writeFileSync(path.join(vitest, "node_modules/vitest/package.json"), JSON.stringify({ name: "vitest", version: "4.0.0", type: "module", exports: { ".": { types: "./index.d.ts" } } }));
  fs.writeFileSync(path.join(vitest, "node_modules/vitest/index.d.ts"), "type Declare = (title: unknown, ...rest: unknown[]) => void;\nexport declare const describe: Declare;\nexport declare const it: Declare;\n");
  assert.equal(cage(vitest, "init", "--agent", "none", "--test-adapter", "vitest").status, 0);
  fs.writeFileSync(path.join(vitest, QUOTA, "defs.ts"), "export interface Shape { n: number }\nexport class Klass { n = 1 }\n");
  fs.writeFileSync(path.join(vitest, QUOTA, "alias.ts"), 'export { Shape as Alias, Klass as Real } from "./defs.ts";\n');
  const vitestTest = (imports, body) =>
    [imports, 'import { describe, it } from "vitest";', 'import { MemoryQuota } from "./memory-quota.ts";', "", "/** @tests Quota */", 'describe("q", () => {', "  /** @covers accounts empty consume race */", `  it("x", () => { void MemoryQuota; ${body} });`, "});", ""].join("\n");
  const aliasCases = [];
  for (const [imports, body, expected] of [
    ['import { Alias } from "./alias.ts";', "void Alias;", "broken"],
    ['import { Alias } from "./alias.ts";', "const s: Alias = { n: 1 }; void s;", "active"],
    ['import { Alias } from "./alias.ts";', "const Alias = 1; void Alias;", "active"],
    ['import { Real } from "./alias.ts";', "void new Real();", "active"],
  ]) {
    fs.writeFileSync(path.join(vitest, QUOTA, "quota.test.ts"), vitestTest(imports, body));
    const check = json(cage(vitest, "check", "--format", "json"));
    const inactive = check.diagnostics.filter(({ code }) => code === "E_TEST_INACTIVE");
    aliasCases.push(`${imports} ${body} -> activeTestDeclarations ${check.counts.activeTestDeclarations}; ${inactive[0]?.message ?? "no E_TEST_INACTIVE"}`);
    if (expected === "broken") assert.ok(inactive.length > 0 && /"Alias" only as a type/.test(inactive[0].message), `${imports} ${body}`);
    else assert.equal(inactive.length, 0, `${imports} ${body}`);
  }
  log("81-vitest-alias", aliasCases.join("\n"));
  pass("6 Vitest alias re-export", "value use of `export { Shape as Alias }` is broken-import; a type use, a shadowing const and a real class alias stay active");

  // ---- 9: the formats of review, in the shipped README and in the CLI.
  const readme = fs.readFileSync(path.join(base, "node_modules/cage-ts/README.md"), "utf8");
  const wrong = cage(loop, "review", "--format", "text");
  const wrongRecord = cage(loop, "review", "--record", "verdicts.json", "--format", "markdown");
  log("90-formats", `${wrong.stderr}\n${wrongRecord.stderr}`);
  assert.match(readme, /the `review` packet `markdown`/);
  assert.match(wrong.stderr, /expected markdown or json/);
  assert.match(wrongRecord.stderr, /expected text or json/);
  pass("9 review formats", "shipped README names markdown for the packet; the CLI names markdown|json and text|json");

  console.log(`\ne2e: ${passed.length} scenarios passed; evidence in ${path.relative(repository, evidence)}`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
