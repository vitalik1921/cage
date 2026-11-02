// Packs the package as npm would ship it, installs it into a scratch project and runs the CLI there:
// the tarball has to carry everything the bin needs, and nothing that only the repository has.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repository = path.resolve(import.meta.dirname, "..");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cage-smoke-"));
try {
  const tarball = execFileSync("npm", ["pack", "--pack-destination", scratch, "--silent"], { cwd: repository, encoding: "utf8" }).trim();
  const project = path.join(scratch, "project");
  fs.cpSync(path.join(repository, "test/fixtures/vertical"), project, { recursive: true });
  // The fixture's tsconfig loads the node types, as a real project would have them.
  const types = JSON.parse(fs.readFileSync(path.join(repository, "package.json"), "utf8")).devDependencies["@types/node"];
  execFileSync("npm", ["install", "--silent", "--no-audit", "--no-fund", "--no-package-lock", path.join(scratch, tarball), `@types/node@${types}`], { cwd: project, stdio: "inherit" });
  const bin = path.join(project, "node_modules", ".bin", process.platform === "win32" ? "cage.cmd" : "cage");
  const run = (...args) => execFileSync(bin, args, { cwd: project, encoding: "utf8", shell: process.platform === "win32" });
  const version = run("--version").trim();
  const report = JSON.parse(run("check", "--format", "json"));
  const errors = report.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (!report.ok || errors.length > 0) throw new Error(`check of the fixture failed:\n${errors.map((d) => `${d.code}: ${d.message}`).join("\n")}`);
  const quota = "src/modules/quota/quota.cage.mdx", draft = "src/modules/quota/quota.cage.draft.mdx";
  const active = fs.readFileSync(path.join(project, quota), "utf8");
  const graph = JSON.parse(run("graph", "Quota", "--used-by", "--format", "json"));
  if (!graph.ok || !graph.nodes.some(node => node.id === "contract:Quota")) throw new Error("Installed graph did not resolve Quota");
  const preview = JSON.parse(run("migrate", "gherkin", "src/modules/quota", "--dry-run", "--format", "json"));
  if (!preview.ok || !preview.files[0].diff.includes("Rule:") || fs.existsSync(path.join(project, draft))) throw new Error("Installed migration preview wrote a draft or lost its rules");
  const migrated = JSON.parse(run("migrate", "gherkin", "src/modules/quota", "--format", "json"));
  const repeated = JSON.parse(run("migrate", "gherkin", "src/modules/quota", "--format", "json"));
  if (migrated.files[0].status !== "created" || repeated.files[0].status !== "unchanged" || fs.readFileSync(path.join(project, quota), "utf8") !== active) throw new Error("Installed migration changed the active design or failed idempotence");
  run("draft", "check", draft);
  // `init` copies the rules and skills out of the package: they have to be in the tarball where it looks for them.
  execFileSync("git", ["init", "--quiet"], { cwd: project });
  run("init", "--agent", "claude", "--agent", "codex");
  for (const file of ["CLAUDE.md", ".claude/settings.json", ".claude/skills/cage-design/SKILL.md", ".claude/skills/cage-review/SKILL.md"]) {
    if (!fs.existsSync(path.join(project, file))) throw new Error(`init did not write ${file}`);
  }
  for (const name of ["cage-design", "cage-review"]) {
    const canonical = fs.readFileSync(path.join(repository, "plugin", "skills", name, "SKILL.md"), "utf8");
    for (const agent of [".claude", ".agents"]) {
      if (fs.readFileSync(path.join(project, agent, "skills", name, "SKILL.md"), "utf8") !== canonical) throw new Error(`Installed ${agent} skill ${name} differs from the package source`);
    }
  }
  const gherkinProject = path.join(project, "gherkin");
  fs.cpSync(path.join(repository, "test/fixtures/gherkin"), gherkinProject, { recursive: true });
  fs.mkdirSync(path.join(gherkinProject, ".cage"));
  fs.writeFileSync(path.join(gherkinProject, ".cage/config.json"), JSON.stringify({ version: 1, examples: "require", review: "off" }));
  const gherkin = JSON.parse(run("check", "--root", gherkinProject, "--format", "json"));
  if (!gherkin.ok || gherkin.counts.implementations !== 4 || gherkin.counts.linkedInvariants !== 10) throw new Error(`Gherkin fixture failed: ${JSON.stringify(gherkin)}`);
  const packet = JSON.parse(run("review", "EntryPicker", "RemoveCourses", "RemoveEducation", "--root", gherkinProject, "--format", "json"));
  if (!packet.complete || packet.gherkin?.length !== 1 || packet.contracts.some(contract => contract.invariants.some(rule => rule.gherkin.examples.some(example => example.tests.length === 0)))) throw new Error("Installed Gherkin review packet lost an Example link or shared context");
  execFileSync(process.execPath, ["--test", "src/removal.test.ts"], { cwd: gherkinProject, encoding: "utf8" });
  const quotaProject = path.join(project, "quota-gherkin");
  fs.cpSync(path.join(repository, "test/fixtures/quota-gherkin"), quotaProject, { recursive: true });
  execFileSync(process.execPath, ["--test", "src/quota.test.ts"], { cwd: quotaProject, encoding: "utf8" });
  const quotaPacket = JSON.parse(run("review", "Quota", "--root", quotaProject, "--format", "json"));
  const findings = JSON.parse(fs.readFileSync(path.join(quotaProject, "review-findings.json"), "utf8"));
  fs.writeFileSync(path.join(quotaProject, "verdict.json"), JSON.stringify({ version: 1, verdicts: [{ contract: "Quota", fingerprint: quotaPacket.contracts[0].fingerprint, findings }] }));
  run("review", "--record", path.join(quotaProject, "verdict.json"), "--root", quotaProject);
  const reviewed = JSON.parse(run("check", "--root", quotaProject, "--format", "json"));
  if (!reviewed.ok || reviewed.diagnostics.length || reviewed.invariants.length !== 2 || reviewed.invariants.some(rule => rule.review !== "adequate")) throw new Error(`Reviewed Quota failed: ${JSON.stringify(reviewed)}`);
  console.log(`smoke: ${tarball} installs; cage ${version} checks the legacy fixture: ${report.counts.contracts} contracts, ${report.counts.linkedInvariants} of ${report.counts.invariants} invariants linked; Gherkin fixture: 4 implementations, 10 linked invariants, required Example links and shared review context pass, runnable tests pass; README Quota: runnable tests and two adequate recorded findings pass with required review/examples, zero diagnostics; migration preview, repeatable checked drafts and used-by graph pass; init writes hooks, rules and identical Claude/Codex skills.`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
