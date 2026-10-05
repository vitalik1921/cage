import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCheck, type CheckOptions } from "./check.ts";
import { isError } from "./diagnostic.ts";
import type { ImplementationPhaseOptions } from "./implementation-phase.ts";
import { formatCheckReport, limitCheckReport } from "./report.ts";

/** How many times in one session the gate blocks before it lets the agent stop with the report. */
export const MAX_BLOCKS = 3;

/** A block counter older than this is of a session that ended while blocked; it is swept on the next run. */
const STALE_COUNTER_MS = 24 * 60 * 60 * 1000;

/** Removes the counters of sessions long gone, so that a blocked session does not leave a file behind for good. */
function sweepCounters(directory: string, now: number): void {
  try {
    for (const name of fs.readdirSync(directory)) {
      if (!name.startsWith("cage-gate-")) continue;
      const file = path.join(directory, name);
      try {
        if (now - fs.statSync(file).mtimeMs > STALE_COUNTER_MS) fs.rmSync(file, { force: true });
      } catch {
        // Gone already, or not ours to remove.
      }
    }
  } catch {
    // An unreadable temporary directory is no reason to fail the gate.
  }
}

/** What an agent's environment tells a Stop hook; both fields are optional. */
export interface HookInput {
  session_id?: string;
  stop_hook_active?: boolean;
}

export interface GateResult {
  /** 0: the agent may stop; 2: it may not, and `feedback` says why. */
  exitCode: 0 | 2;
  /** For stderr: the check's report and what to do, or why a failing check lets the agent go. */
  feedback: string;
}

/**
 * `cage gate`: the full check as a stop-gate for an agent's environment.
 * Errors block; so does a missing or stale review, whatever the configured
 * review level, since a change needs a fresh verdict. A weak finding blocks
 * only under `"review": "require"`, where it is an error (code the design
 * does not cover likewise blocks only under `"coverage": "require"`). A
 * project without any design yet passes, since there is nothing to hold the
 * agent to;
 * the report and the way out go to the agent as feedback. A check that
 * still fails after `MAX_BLOCKS` blocks in one session lets the agent stop,
 * with the report: a check the agent cannot fix must not hold the session
 * forever. Blocks are counted in a file of the temporary directory. The
 * feedback shows at most `maxDiagnostics`, the ones that matter most, so
 * that a long report does not drown the agent; what blocks is counted
 * over all of them.
 */
export function runGate(options: ImplementationPhaseOptions, checkOptions: CheckOptions, input: HookInput, maxDiagnostics: number | "all" = "all"): GateResult {
  const report = runCheck(options, "implementation", checkOptions);
  // A missing or stale review blocks at any level: a change needs a fresh second look. A weak finding is a recorded judgement;
  // it blocks only where the project requires reviews to be adequate, and then it is an error like any other.
  const blocking = report.diagnostics.filter((diagnostic) => isError(diagnostic) || /REVIEW_(MISSING|STALE)$/.test(diagnostic.code));
  const session = (input.session_id ?? "session").replace(/[^A-Za-z0-9_-]/g, "");
  // Per project too: one session may stop at several projects of a monorepo, and each counts its own blocks.
  const project = crypto.createHash("sha256").update(path.resolve(options.root)).digest("hex").slice(0, 12);
  const counter = path.join(os.tmpdir(), `cage-gate-${session}-${project}`);
  sweepCounters(os.tmpdir(), Date.now());
  if (blocking.length === 0) {
    fs.rmSync(counter, { force: true });
    return { exitCode: 0, feedback: "" };
  }
  // A project right after `cage init` has no design yet: there is nothing to hold the agent to.
  if (blocking.every((diagnostic) => diagnostic.code === "E_NO_DESIGNS")) {
    fs.rmSync(counter, { force: true });
    return { exitCode: 0, feedback: "cage gate: no *.cage.mdx design yet, nothing to check.\n" };
  }

  const text = formatCheckReport(limitCheckReport(report, maxDiagnostics));
  let blocks = 0;
  try {
    blocks = Number(fs.readFileSync(counter, "utf8")) || 0;
  } catch {
    // No block in this session yet.
  }
  if (input.stop_hook_active && blocks >= MAX_BLOCKS) {
    return { exitCode: 0, feedback: `cage gate: \`cage check\` still fails after ${MAX_BLOCKS} attempts; letting the agent stop.\n${text}` };
  }
  try {
    fs.writeFileSync(counter, String(blocks + 1));
  } catch {
    // Without the counter the gate blocks every time; that is the safer failure.
  }
  const guidance = [
    `\`cage check\` is not clean (${blocking.length} blocking). Fix what it reports before stopping.`,
    "For REVIEW_MISSING or REVIEW_STALE: `cage review` lists what needs a review and what changed; `cage review <Name>` gives one contract's material. Read it, write the verdict in the format it ends with, and record it with `cage review --record <file>`.",
    ...(blocking.some((diagnostic) => diagnostic.code === "E_REVIEW_WEAK") ? ["For E_REVIEW_WEAK: improve the test or the design as the finding suggests, then review again."] : []),
    "Never lower an assessment or drop an invariant to pass.",
  ];
  return { exitCode: 2, feedback: `${text}\n${guidance.join(" ")}\n` };
}

/** The hook's input from stdin, when there is any; a missing or malformed input changes nothing. */
export function parseHookInput(stdin: string | undefined): HookInput {
  if (!stdin) return {};
  try {
    const value: unknown = JSON.parse(stdin);
    if (typeof value !== "object" || value === null) return {};
    const { session_id, stop_hook_active } = value as Record<string, unknown>;
    return { ...(typeof session_id === "string" ? { session_id } : {}), ...(typeof stop_hook_active === "boolean" ? { stop_hook_active } : {}) };
  } catch {
    return {};
  }
}
