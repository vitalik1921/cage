#!/usr/bin/env node
// Stop hook for Claude Code: the agent may not finish while `design check` fails.
//
// Install: copy this file to .claude/hooks/design-gate.mjs of your project and add the
// entry from settings.json here to .claude/settings.json. Requires the harness as a
// dependency of the project (node_modules/.bin/design), `design` on PATH, or DESIGN_BIN
// naming the executable. An optional argument names the project root relative to the
// repository, for a project inside a monorepo: `design-gate.mjs apps/api`.
//
// A failing check is fed back to the agent (exit 2 + stderr). Review findings count as
// failures whatever the "review" level in .design/config.json says, so that the loop
// `design review` → verdict → `design review --record` runs before the agent stops.
// After three blocks in one session the agent may stop anyway, with the report on stderr:
// a check it cannot fix must not hold the session forever.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_BLOCKS = 3;

let input = {};
try {
  input = JSON.parse(fs.readFileSync(0, "utf8"));
} catch {
  // No or malformed input: the check still decides.
}
const repository = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
const root = path.resolve(repository, process.argv[2] ?? ".");
const bin = process.platform === "win32" ? "design.cmd" : "design";
const candidates = [process.env.DESIGN_BIN, path.join(root, "node_modules", ".bin", bin), path.join(repository, "node_modules", ".bin", bin)].filter(Boolean);
const command = candidates.find((candidate) => fs.existsSync(candidate)) ?? "design";

const result = spawnSync(command, ["check", "--root", root, "--format", "json"], { encoding: "utf8", windowsHide: true, shell: process.platform === "win32" });
if (result.error) {
  process.stderr.write(`design-gate: cannot run \`${command}\`: ${result.error.message}. Install the harness or put \`design\` on PATH.\n`);
  process.exit(0);
}
let report;
try {
  report = JSON.parse(result.stdout);
} catch {
  process.stderr.write(`design-gate: \`design check\` gave no report (exit ${result.status}).\n${result.stderr}${result.stdout}`);
  process.exit(result.status === 0 ? 0 : 2);
}
const blocking = report.diagnostics.filter((d) => d.severity === "error" || d.code.includes("REVIEW_"));
const counter = path.join(os.tmpdir(), `design-gate-${(input.session_id || "session").replace(/[^A-Za-z0-9_-]/g, "")}`);
if (blocking.length === 0) {
  fs.rmSync(counter, { force: true });
  process.exit(0);
}

const text = spawnSync(command, ["check", "--root", root], { encoding: "utf8", windowsHide: true, shell: process.platform === "win32" }).stdout;
const blocks = Number(fs.existsSync(counter) ? fs.readFileSync(counter, "utf8") : 0) + 1;
if (input.stop_hook_active && blocks > MAX_BLOCKS) {
  process.stderr.write(`design-gate: \`design check\` still fails after ${MAX_BLOCKS} attempts; letting the agent stop.\n${text}`);
  process.exit(0);
}
fs.writeFileSync(counter, String(blocks));
process.stderr.write(
  `${text}\n\`design check\` is not clean (${blocking.length} blocking). Fix what it reports before stopping. ` +
    "For REVIEW_MISSING or REVIEW_STALE: run `design review`, read the material, write the verdict in the format it ends with, and record it with `design review --record <file>`. " +
    "For REVIEW_WEAK: improve the test or the design as the finding suggests, then review again. Never lower an assessment or drop an invariant to pass.\n",
);
process.exit(2);
