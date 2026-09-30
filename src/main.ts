import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { runCheck } from "./check.ts";
import { loadConfig } from "./config.ts";
import { isError, type Diagnostic } from "./diagnostic.ts";
import { discoverDesigns, discoverSources } from "./discovery.ts";
import { runExtract } from "./extract.ts";
import { runLock } from "./lock-command.ts";
import { formatRecordReport, recordVerdicts } from "./review-record.ts";
import { formatReviewMarkdown, runReview } from "./review.ts";
import { formatCheckReport, formatExtractReport, formatLockReport } from "./report.ts";

export interface CliIo {
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const USAGE = `Usage: design <command> [options]

Commands:
  check                 Check the designs, the generated files, the implementations and the test links
  check --phase design  Check only the designs: documents, contracts, tags, references and types
  check --base <rev>    Also require every lock recorded at that Git revision (for CI: --base origin/main)
  extract               Check the designs and write each .design/design.generated.ts
  extract --check       Check the designs and that the generated files are current; write nothing
  lock                  Record the declarations marked @final or @extendable in .design/design.lock.json
  review [name...]      The material of the named contracts for a reviewer: markdown (default) or json;
                        without names, the contracts without a fresh recorded review; --all for every contract
  review --record <f>   Record the verdicts in <f> (json, the shape the review asks for) in .design/review.json

Options:
  --root <path>     Project root (default: the current directory)
  --config <path>   Configuration file, relative to the project root (default: .design/config.json if present)
  --format <format> Report format: text (default) or json; for review markdown (default) or json
  --all             review: every contract, not only those in need of a review
  -h, --help        Show this help
  --version         Show the version

Exit codes: 0 success; 1 rule violations or generated files not current; 2 invalid arguments, configuration or environment.
`;

class UsageError extends Error {}

/** Runs the CLI and returns the exit code. Reports go to stdout, usage and internal errors to stderr. */
export function runCli(argv: readonly string[], io: CliIo): number {
  try {
    return run(argv, io);
  } catch (cause) {
    if (cause instanceof UsageError) {
      io.stderr(`design: ${cause.message}\nRun \`design --help\` for usage.\n`);
    } else if (cause instanceof Error && "syscall" in cause) {
      // A file system failure, such as a directory that cannot be read: the message names the path.
      io.stderr(`design: ${cause.message}\n`);
    } else {
      io.stderr(`design: internal error: ${cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)}\n`);
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
        check: { type: "boolean" },
        all: { type: "boolean" },
        record: { type: "string" },
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
  if (command !== "extract" && command !== "check" && command !== "lock" && command !== "review") throw new UsageError(`Unknown command "${command}".`);
  if (command !== "review" && extra.length > 0) throw new UsageError(`Unexpected argument "${extra[0]}".`);
  if (command !== "review" && values.all) throw new UsageError("--all is an option of the review command.");
  if (command === "review" && values.all && extra.length > 0) throw new UsageError("--all reviews every contract; do not name contracts with it.");
  if (command !== "review" && values.record !== undefined) throw new UsageError("--record is an option of the review command.");
  if (values.record !== undefined && (values.all || extra.length > 0)) throw new UsageError("--record takes the verdicts file only; the contracts are those in it.");
  if (values.record !== undefined && values.record.trim() === "") throw new UsageError("--record needs the path of a verdicts file.");
  if (command !== "check" && values.phase !== undefined) throw new UsageError("--phase is an option of the check command.");
  if (command !== "check" && values.base !== undefined) throw new UsageError("--base is an option of the check command.");
  if (values.base !== undefined && values.base.trim() === "") throw new UsageError("--base needs a Git revision, such as origin/main.");
  if (command !== "extract" && values.check) throw new UsageError("--check is an option of the extract command.");
  if (command === "check") {
    if (values.phase !== undefined && values.phase !== "design" && values.phase !== "implementation") {
      throw new UsageError(`Unknown phase "${values.phase}"; expected design or implementation.`);
    }
  }

  const formats = command === "review" && values.record === undefined ? ["markdown", "json"] : ["text", "json"];
  const format = values.format ?? formats[0];
  if (!formats.includes(format)) throw new UsageError(`Unknown format "${format}"; expected ${formats.join(" or ")}.`);

  const root = path.resolve(io.cwd, values.root ?? ".");
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) throw new UsageError(`The project root "${root}" is not a directory.`);

  const { config, diagnostics } = loadConfig(root, values.config);
  const scope = {
    root,
    tsconfig: config.tsconfig,
    // With an unusable configuration there is no scope: only its errors are reported.
    designs: diagnostics.length > 0 ? [] : discoverDesigns(root, config),
    problems: diagnostics,
  };
  const print = (report: { diagnostics: Diagnostic[] }, text: string) => {
    io.stdout(format === "json" ? `${JSON.stringify(report, null, 2)}\n` : text);
    return exitCode(report.diagnostics);
  };

  if (command === "check") {
    const phase = values.phase === "design" ? "design" : "implementation";
    // The design phase does not look at source files, so it does not search for them either.
    const sources = phase === "design" || diagnostics.length > 0 ? { implementations: [], tests: [] } : discoverSources(root, config);
    const report = runCheck({ ...scope, sources, testAdapter: config.testAdapter, generatedFiles: config.generatedFiles }, phase, { lockBase: values.base, review: config.review });
    return print(report, formatCheckReport(report));
  }
  if (command === "lock") {
    const report = runLock(scope);
    return print(report, formatLockReport(report));
  }
  if (command === "review") {
    const sources = diagnostics.length > 0 ? { implementations: [], tests: [] } : discoverSources(root, config);
    const phaseOptions = { ...scope, sources, testAdapter: config.testAdapter, generatedFiles: config.generatedFiles };
    if (values.record !== undefined) {
      const report = recordVerdicts(phaseOptions, values.record);
      return print(report, formatRecordReport(report));
    }
    const report = runReview(phaseOptions, extra.length > 0 ? extra : values.all ? "all" : "needed");
    io.stdout(format === "json" ? `${JSON.stringify(report, null, 2)}\n` : formatReviewMarkdown(report));
    // An export succeeds with structural errors in the material; it fails when the packets could not be made.
    return exitCode(report.diagnostics) === 2 ? 2 : report.ok ? 0 : 1;
  }
  const report = runExtract(scope, values.check ?? false, config.generatedFiles);
  return print(report, formatExtractReport(report));
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
