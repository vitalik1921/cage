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
  // `init` copies the rules and skills out of the package: they have to be in the tarball where it looks for them.
  execFileSync("git", ["init", "--quiet"], { cwd: project });
  run("init", "--agent", "claude");
  for (const file of ["CLAUDE.md", ".claude/settings.json", ".claude/skills/cage-design/SKILL.md", ".claude/skills/cage-review/SKILL.md"]) {
    if (!fs.existsSync(path.join(project, file))) throw new Error(`init did not write ${file}`);
  }
  console.log(`smoke: ${tarball} installs; cage ${version} checks the fixture: ${report.counts.contracts} contracts, ${report.counts.linkedInvariants} of ${report.counts.invariants} invariants linked; init writes the hook, the rules and the skills.`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
