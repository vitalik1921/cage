import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCheck, type CheckOptions } from "./check.ts";
import { isError } from "./diagnostic.ts";
import type { ImplementationPhaseOptions } from "./implementation-phase.ts";
import { formatCheckReport } from "./report.ts";

/** How many times in one session the gate blocks before it lets the agent stop with the report. */
export const MAX_BLOCKS = 3;

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
 * Errors and review findings block, whatever the configured review level;
 * the report and the way out go to the agent as feedback. A check that
 * still fails after `MAX_BLOCKS` blocks in one session lets the agent stop,
 * with the report: a check the agent cannot fix must not hold the session
 * forever. Blocks are counted in a file of the temporary directory.
 */
export function runGate(options: ImplementationPhaseOptions, checkOptions: CheckOptions, input: HookInput): GateResult {
  const report = runCheck(options, "implementation", checkOptions);
  const blocking = report.diagnostics.filter((diagnostic) => isError(diagnostic) || diagnostic.code.includes("REVIEW_"));
  const session = (input.session_id ?? "session").replace(/[^A-Za-z0-9_-]/g, "");
  const counter = path.join(os.tmpdir(), `cage-gate-${session}`);
  if (blocking.length === 0) {
    fs.rmSync(counter, { force: true });
    return { exitCode: 0, feedback: "" };
  }

  const text = formatCheckReport(report);
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
    "For REVIEW_MISSING or REVIEW_STALE: run `cage review`, read the material, write the verdict in the format it ends with, and record it with `cage review --record <file>`.",
    "For REVIEW_WEAK: improve the test or the design as the finding suggests, then review again. Never lower an assessment or drop an invariant to pass.",
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
