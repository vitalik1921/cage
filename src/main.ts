import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.ts";
import type { Diagnostic } from "./diagnostic.ts";
import { discoverDesigns } from "./discovery.ts";
import { runExtract, type ExtractReport } from "./extract.ts";
import { formatExtractReport } from "./report.ts";

export interface CliIo {
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const USAGE = `Usage: design <command> [options]

Commands:
  extract           Check the designs and write each .design/design.generated.ts
  extract --check   Check the designs and that the generated files are current; write nothing

Options:
  --root <path>     Project root (default: the current directory)
  --config <path>   Configuration file, relative to the project root (default: .design/config.json if present)
  --format <format> Report format: text (default) or json
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
        check: { type: "boolean" },
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
  if (command !== "extract") throw new UsageError(`Unknown command "${command}".`);
  if (extra.length > 0) throw new UsageError(`Unexpected argument "${extra[0]}".`);

  const format = values.format ?? "text";
  if (format !== "text" && format !== "json") throw new UsageError(`Unknown format "${format}"; expected text or json.`);

  const root = path.resolve(io.cwd, values.root ?? ".");
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) throw new UsageError(`The project root "${root}" is not a directory.`);

  const { config, diagnostics } = loadConfig(root, values.config);
  const report: ExtractReport =
    diagnostics.length > 0
      ? { schemaVersion: 1, command: "extract", checkOnly: values.check ?? false, ok: false, outputs: [], diagnostics }
      : runExtract({ root, tsconfig: config.tsconfig, designs: discoverDesigns(root, config) }, values.check ?? false);

  io.stdout(format === "json" ? `${JSON.stringify(report, null, 2)}\n` : formatExtractReport(report));
  return exitCode(report.diagnostics);
}

/** 2 when the configuration or environment is unusable, 1 for any other error, 0 otherwise. */
function exitCode(diagnostics: readonly Diagnostic[]): number {
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.some((diagnostic) => diagnostic.code === "E_CONFIG" || diagnostic.code === "E_ENVIRONMENT")) return 2;
  return errors.length > 0 ? 1 : 0;
}

function readVersion(): string {
  const manifest = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  return manifest.version;
}
