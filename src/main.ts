import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { runCheck } from "./check.ts";
import { formatCodes } from "./codes.ts";
import { isMaxDiagnostics, loadConfig, MAX_DIAGNOSTICS_LIMIT, type Config } from "./config.ts";
import { isError, type Diagnostic } from "./diagnostic.ts";
import { discoverDesigns, discoverSources } from "./discovery.ts";
import { parseHookInput, runGate } from "./gate.ts";
import { formatInitReport, runInit, type Agent } from "./init.ts";
import { runLock } from "./lock-command.ts";
import { acceptContracts, formatAcceptReport, formatRecordReport, recordVerdicts } from "./review-record.ts";
import { formatReviewIndexMarkdown, formatReviewMarkdown, runReview, runReviewIndex, type Included } from "./review.ts";
import { formatCheckReport, formatLockReport, limitCheckReport } from "./report.ts";

export interface CliIo {
  cwd: string;
  /** What was piped in, for `gate`; undefined when stdin is a terminal. */
  stdin?: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /**
   * Asks the person at the terminal: writes the question to stderr and
   * returns the line typed, or null at the end of input. Undefined when
   * nobody can answer, such as in a pipe or in CI.
   */
  ask?: (question: string) => string | null;
}

const USAGE = `Usage: cage <command> [options]

Commands:
  init                  Write .cage/config.json and set the Stop gate up: --agent claude, codex, or none;
                        without --agent it asks in a terminal and fails elsewhere
  check                 Check the designs, the implementations, the test links, the locks and the reviews
  check --phase design  Check only the designs: documents, contracts, tags, references and types
  check --base <rev>    Also require every lock recorded at that Git revision (for CI: --base origin/main)
  lock                  Record the declarations marked @final or @extendable in .cage/lock.json
  review                Suggested review groups and commands, plus the contracts without a fresh recorded review, what changed since the
                        recorded one and which invariants it touches; --all lists every contract. markdown (default) or json
  review <name...>      The material of the named contracts, one packet each, with the verdict template at the end;
                        --files changed (default): the lines that changed since the recorded review, everything when there
                        is none; --files all: every file whole; --files none: references only
  review --record <f>   Record the verdicts in <f> (json, the shape the review asks for; relative to the current directory) in .cage/review.json
  review --accept [name...]
                        Accept the material of the contracts as it is now without a review, in .cage/review.json: check asks for none
                        until it changes, and counts them apart from reviewed ones. Without names, every contract in need of a review;
                        --all for every contract, replacing recorded verdicts too
  gate                  Stop hook for an agent's environment: the full check; only errors block (exit 2,
                        only blocking diagnostics and guidance on stderr); after 3 blocks in one session the agent may stop. Reads the hook's JSON on stdin
  codes                 What every diagnostic code means and what to do about it; a diagnostic line itself names only the thing and the place

Options:
  --root <path>     Project root (default: the current directory)
  --config <path>   Configuration file, relative to the project root (default: .cage/config.json if present)
  --format <format> Report format: text (default) or json; for review markdown (default) or json
  --max-diagnostics <n|all>
                    check, gate: show at most n diagnostics, the ones that matter most, and count the rest by code
                    (default: "maxDiagnostics" in the configuration, 50)
  --all             review: list every contract, not only those in need of a review
  --files <mode>    review <name...>: changed (default), context (experimental), all or none
  --agent <name>    init: claude, codex or none; may be repeated (claude and codex)
  --test-adapter <name>  init: node:test or vitest (default: vitest when package.json depends on it)
  -h, --help        Show this help
  --version         Show the version

Exit codes: 0 success; 1 rule violations; 2 invalid arguments, configuration or environment;
130 init cancelled at its question.
For gate: 0 the agent may stop, 2 it may not (the hook protocol).
`;

class UsageError extends Error {}

/**
 * Runs the CLI and returns the exit code. Reports go to stdout, usage and internal errors to stderr.
 * @implements Cli
 */
export function runCli(argv: readonly string[], io: CliIo): number {
  try {
    return run(argv, io);
  } catch (cause) {
    if (cause instanceof UsageError) {
      io.stderr(`cage: ${cause.message}\nRun \`cage --help\` for usage.\n`);
    } else if (cause instanceof Error && "syscall" in cause) {
      // A file system failure, such as a directory that cannot be read: the message names the path.
      io.stderr(`cage: ${cause.message}\n`);
    } else {
      io.stderr(`cage: internal error: ${cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)}\n`);
    }
    return 2;
  }
}

function run(argv: readonly string[], io: CliIo): number {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        root: { type: "string" },
        config: { type: "string" },
        format: { type: "string" },
        phase: { type: "string" },
        base: { type: "string" },
        all: { type: "boolean" },
        record: { type: "string" },
        accept: { type: "boolean" },
        files: { type: "string" },
        "max-diagnostics": { type: "string" },
        agent: { type: "string", multiple: true },
        "test-adapter": { type: "string" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean" },
      },
    });
  } catch (cause) {
    throw new UsageError((cause as Error).message);
  }
  const { values, positionals } = parsed;

  if (values.help) {
    io.stdout(USAGE);
    return 0;
  }
  if (values.version) {
    io.stdout(`${readVersion()}\n`);
    return 0;
  }

  const [command, ...extra] = positionals;
  if (command === undefined) throw new UsageError("Missing command.");
  const COMMANDS = ["init", "check", "lock", "review", "gate", "codes"];
  if (!COMMANDS.includes(command)) throw new UsageError(`Unknown command "${command}".`);
  if (command !== "init" && (values.agent !== undefined || values["test-adapter"] !== undefined)) throw new UsageError("--agent and --test-adapter are options of the init command.");
  const agents = new Set<Agent>();
  for (const agent of values.agent ?? []) {
    if (agent === "claude" || agent === "codex") agents.add(agent);
    else if (agent !== "none") throw new UsageError(`Unknown agent "${agent}"; expected claude, codex or none.`);
  }
  if (values.agent?.includes("none") && agents.size > 0) throw new UsageError("--agent none means no Stop gate; do not combine it with an agent.");
  const testAdapter = values["test-adapter"];
  if (testAdapter !== undefined && testAdapter !== "node:test" && testAdapter !== "vitest") throw new UsageError(`Unknown test adapter "${testAdapter}"; expected node:test or vitest.`);
  if (command !== "review" && extra.length > 0) throw new UsageError(`Unexpected argument "${extra[0]}".`);
  if (command !== "review" && values.all) throw new UsageError("--all is an option of the review command.");
  if (command === "review" && values.all && extra.length > 0) throw new UsageError("--all reviews every contract; do not name contracts with it.");
  if (command !== "review" && values.record !== undefined) throw new UsageError("--record is an option of the review command.");
  if (values.record !== undefined && (values.all || extra.length > 0)) throw new UsageError("--record takes the verdicts file only; the contracts are those in it.");
  if (values.record !== undefined && values.record.trim() === "") throw new UsageError("--record needs the path of a verdicts file.");
  if (command !== "review" && values.accept) throw new UsageError("--accept is an option of the review command.");
  if (values.files !== undefined && (command !== "review" || values.record !== undefined || values.accept || extra.length === 0)) throw new UsageError("--files is an option of review with the names of contracts.");
  if (values.files !== undefined && values.files !== "all" && values.files !== "changed" && values.files !== "context" && values.files !== "none") throw new UsageError(`Unknown --files mode "${values.files}"; expected changed, context, all or none.`);
  if (values.accept && values.record !== undefined) throw new UsageError("--accept records acceptances, --record a reviewer's verdicts; pass one of them.");
  if (command !== "check" && command !== "gate" && values["max-diagnostics"] !== undefined) throw new UsageError("--max-diagnostics is an option of the check and gate commands.");
  const maxDiagnostics = parseMaxDiagnostics(values["max-diagnostics"]);
  if (command !== "check" && values.phase !== undefined) throw new UsageError("--phase is an option of the check command.");
  if (command !== "check" && command !== "gate" && values.base !== undefined) throw new UsageError("--base is an option of the check and gate commands.");
  if (command === "gate" && values.format !== undefined) throw new UsageError("gate has no --format: its report goes to the agent as text.");
  if (values.base !== undefined && values.base.trim() === "") throw new UsageError("--base needs a Git revision, such as origin/main.");
  if (values.root !== undefined && values.root.trim() === "") throw new UsageError("--root needs the path of the project directory.");
  if (values.config !== undefined && values.config.trim() === "") throw new UsageError("--config needs the path of a configuration file.");
  if (command === "check") {
    if (values.phase !== undefined && values.phase !== "design" && values.phase !== "implementation") {
      throw new UsageError(`Unknown phase "${values.phase}"; expected design or implementation.`);
    }
  }

  if (command === "codes") {
    // The legend is the same for every project: the global options are accepted, the commands' own are not.
    if ([values.format, values.phase, values.base, values.all, values.record, values.accept, values.files, values["max-diagnostics"]].some((value) => value !== undefined)) throw new UsageError("codes takes no options but --root and --config.");
    io.stdout(formatCodes());
    return 0;
  }
  const formats = command === "review" && values.record === undefined && !values.accept ? ["markdown", "json"] : ["text", "json"];
  const format = values.format ?? formats[0];
  if (!formats.includes(format)) {
    const what = command === "review" ? (values.accept ? "review --accept" : values.record === undefined ? "the review packet" : "review --record") : command;
    throw new UsageError(`Unknown format "${format}" for ${what}; expected ${formats.join(" or ")}.`);
  }

  const root = path.resolve(io.cwd, values.root ?? ".");
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) throw new UsageError(`The project root "${root}" is not a directory.`);

  if (command === "init") {
    if (values.config !== undefined) throw new UsageError("init writes the default configuration file; --config does not apply.");
    let chosen: Agent[] = [...agents];
    if (values.agent === undefined) {
      if (!io.ask) throw new UsageError("init sets the Stop gate up for an agent and asks which one only in a terminal; pass --agent claude, --agent codex (both may be given) or --agent none.");
      const answer = askAgents(io, io.ask);
      if (answer === null) {
        io.stderr("cage: init cancelled; nothing was written.\n");
        return CANCELLED;
      }
      chosen = answer;
    }
    const report = runInit({ root, agents: chosen, testAdapter });
    io.stdout(format === "json" ? `${JSON.stringify(report, null, 2)}\n` : formatInitReport(report));
    return exitCode(report.diagnostics);
  }

  const { config, diagnostics } = loadConfig(root, values.config);
  const scope = {
    root,
    tsconfig: config.tsconfig,
    // With an unusable configuration there is no scope: only its errors are reported.
    designs: diagnostics.length > 0 ? [] : discoverDesigns(root, config),
    designPatterns: config.designs,
    problems: diagnostics,
  };
  // Review fingerprints skip what the project excludes from its scope, and what it excludes from them on top.
  const reviewScope = { ...config.reviewDependencies, exclude: [...config.exclude, ...config.reviewDependencies.exclude] };
  const print = (report: { diagnostics: Diagnostic[] }, text: string) => {
    io.stdout(format === "json" ? `${JSON.stringify(report, null, 2)}\n` : text);
    return exitCode(report.diagnostics);
  };

  if (command === "check") {
    const phase = values.phase === "design" ? "design" : "implementation";
    // The design phase does not look at source files, so it does not search for them either.
    const sources = phase === "design" || diagnostics.length > 0 ? { implementations: [], tests: [] } : discoverSources(root, config);
    const report = runCheck({ ...scope, sources, testAdapter: config.testAdapter, coverage: config.coverage, reviewScope }, phase, { lockBase: values.base, review: config.review });
    // What is shown is limited; the exit code is of everything that was found.
    const shown = limitCheckReport(report, maxDiagnostics ?? config.maxDiagnostics);
    io.stdout(format === "json" ? `${JSON.stringify(shown, null, 2)}\n` : formatCheckReport(shown));
    return exitCode(report.diagnostics);
  }
  if (command === "lock") {
    const report = runLock(scope);
    return print(report, formatLockReport(report));
  }
  if (command === "gate") {
    const sources = diagnostics.length > 0 ? { implementations: [], tests: [] } : discoverSources(root, config);
    const { exitCode, feedback } = runGate({ ...scope, sources, testAdapter: config.testAdapter, coverage: config.coverage, reviewScope }, { lockBase: values.base, review: config.review }, parseHookInput(io.stdin), maxDiagnostics ?? config.maxDiagnostics);
    if (feedback !== "") io.stderr(feedback);
    return exitCode;
  }
  if (command === "review") {
    const sources = diagnostics.length > 0 ? { implementations: [], tests: [] } : discoverSources(root, config);
    const phaseOptions = { ...scope, sources, testAdapter: config.testAdapter, coverage: config.coverage, reviewScope };
    if (values.record !== undefined) {
      const report = recordVerdicts(phaseOptions, path.resolve(io.cwd, values.record));
      return print(report, formatRecordReport(report));
    }
    if (values.accept) {
      const report = acceptContracts(phaseOptions, extra.length > 0 ? extra : values.all ? "all" : "needed");
      return print(report, formatAcceptReport(report));
    }
    // Without names the index; with names the packets. An export succeeds with structural errors in the material; it fails when it could not be made.
    const report = extra.length > 0 ? runReview(phaseOptions, extra, values.files as Included | undefined) : runReviewIndex(phaseOptions, values.all ? "all" : "needed");
    io.stdout(format === "json" ? `${JSON.stringify(report, null, 2)}\n` : "included" in report ? formatReviewMarkdown(report) : formatReviewIndexMarkdown(report));
    return exitCode(report.diagnostics) === 2 ? 2 : report.ok ? 0 : 1;
  }
  throw new UsageError(`Unknown command "${command}".`);
}

/** The exit code of an init whose question was left unanswered: the shell's code for an interrupted command. */
const CANCELLED = 130;
/** Answers to the question of `init`; there is no default, a person picks one. */
const AGENT_CHOICES: Record<string, Agent[]> = { "1": ["claude"], claude: ["claude"], "2": ["codex"], codex: ["codex"], "3": ["claude", "codex"], both: ["claude", "codex"], "4": [], none: [] };
const AGENT_QUESTION = `Which agent should cage hold to the designs here? Its Stop gate, rules and skills go to the Git repository of the project.
  1) claude  Claude Code: .claude/settings.json, CLAUDE.md, .claude/skills/
  2) codex   Codex: .codex/config.toml, AGENTS.md, .agents/skills/
  3) both
  4) none    no Stop gate: .cage/config.json only
Files that are already there are kept or added to; nothing is overwritten.
`;
/** Answers that pick nothing before `init` gives up: a person who means none says none. */
const MAX_ANSWERS = 5;

/** The agents a person picks at the terminal; null when the input ends first. */
function askAgents(io: CliIo, ask: (question: string) => string | null): Agent[] | null {
  io.stderr(AGENT_QUESTION);
  for (let attempt = 1; ; attempt++) {
    const answer = ask("Choose 1-4 or a name (claude, codex, both, none): ");
    if (answer === null) return null;
    const key = answer.trim().toLowerCase();
    if (Object.hasOwn(AGENT_CHOICES, key)) return [...AGENT_CHOICES[key]];
    if (attempt === MAX_ANSWERS) throw new UsageError(`No agent chosen after ${MAX_ANSWERS} answers; nothing was written. Pass --agent claude, --agent codex or --agent none.`);
    // What was typed is shown escaped: a stray control sequence does not reach the terminal.
    io.stderr(key === "" ? "There is no default; type one of the choices.\n" : `${JSON.stringify(answer.trim().slice(0, 40))} is not one of the choices.\n`);
  }
}

/** `--max-diagnostics` as typed: a whole number or "all"; undefined when not given, so that the configuration decides. */
function parseMaxDiagnostics(given: string | undefined): Config["maxDiagnostics"] | undefined {
  if (given === undefined) return undefined;
  const text = given.trim();
  const value = text === "all" ? "all" : /^\d+$/.test(text) ? Number(text) : text;
  if (!isMaxDiagnostics(value)) throw new UsageError(`--max-diagnostics needs a whole number from 0 to ${MAX_DIAGNOSTICS_LIMIT}, or all; got "${given}".`);
  return value;
}

/** 2 when the configuration or environment is unusable, 1 for any other error, 0 otherwise. */
function exitCode(diagnostics: readonly Diagnostic[]): number {
  const errors = diagnostics.filter(isError);
  if (errors.some((diagnostic) => diagnostic.code === "E_CONFIG" || diagnostic.code === "E_ENVIRONMENT")) return 2;
  return errors.length > 0 ? 1 : 0;
}

function readVersion(): string {
  const manifest = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  return manifest.version;
}
