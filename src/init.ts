import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_CONFIG_FILE } from "./config.ts";
import { compareDiagnostics, hasErrors, type Diagnostic } from "./diagnostic.ts";
import { stripBom, toProjectPath } from "./location.ts";
import { writeRecordFile } from "./record-file.ts";

export type Agent = "claude" | "codex";

export interface InitOptions {
  /** The project root: where `.cage/config.json` goes. */
  root: string;
  /** The environments to set the Stop gate up for; empty for the configuration alone. */
  agents: readonly Agent[];
  /** The test runner to configure; detected from package.json when not given. */
  testAdapter?: "node:test" | "vitest";
}

export interface InitReport {
  schemaVersion: 1;
  command: "init";
  ok: boolean;
  /** The directory the agent runs in: the Git repository that holds the root, or the root itself. Relative to the root. */
  repository: string;
  agents: Agent[];
  files: { path: string; status: "created" | "updated" | "kept" }[];
  diagnostics: Diagnostic[];
}

/** What a project's CLAUDE.md or AGENTS.md gets: the rules for an agent, shipped with the package. */
const INSTRUCTIONS_FILE = new URL("../examples/claude-code/CLAUDE.md", import.meta.url);

/**
 * `cage init`: the first configuration, and the Stop gate of the agent's
 * environment. Everything is written once: a file that is already there is
 * kept, a settings file that has other hooks gets the gate added, and a
 * second run changes nothing.
 */
export function runInit(options: InitOptions): InitReport {
  const root = path.resolve(options.root);
  const diagnostics: Diagnostic[] = [];
  const files: InitReport["files"] = [];
  const repository = repositoryOf(root);
  const report = (): InitReport => ({
    schemaVersion: 1,
    command: "init",
    ok: !hasErrors(diagnostics),
    repository: toProjectPath(root, repository) || ".",
    agents: [...options.agents],
    files,
    diagnostics: diagnostics.sort(compareDiagnostics),
  });
  const environment = (file: string, action: string, cause: unknown) => {
    diagnostics.push({ code: "E_ENVIRONMENT", severity: "error", message: `Cannot ${action} ${file}: ${(cause as Error).message}`, file });
  };
  /** Writes `text` to `file` (absolute) unless `keep` says the current content already has what it needs. */
  const put = (file: string, text: string | ((current: string | undefined) => string | undefined)) => {
    const shown = toProjectPath(root, file);
    let current: string | undefined;
    try {
      current = fs.readFileSync(file, "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") return environment(shown, "read", cause);
    }
    const next = typeof text === "string" ? (current === undefined ? text : undefined) : text(current);
    if (next === undefined) return files.push({ path: shown, status: "kept" });
    try {
      writeRecordFile(file, next);
      files.push({ path: shown, status: current === undefined ? "created" : "updated" });
    } catch (cause) {
      environment(shown, "write", cause);
    }
  };

  // The configuration: the detected runner and both levels spelled out, so that the project sees what it can change.
  const testAdapter = options.testAdapter ?? detectTestAdapter([root, repository]);
  const tests = testAdapter === "vitest" ? ["src/**/*.{test,spec}.ts"] : ["src/**/*.test.ts", "tests/**/*.test.ts"];
  put(path.join(root, DEFAULT_CONFIG_FILE), `${JSON.stringify({ version: 1, tests, testAdapter, review: "warn", coverage: "warn" }, null, 2)}\n`);

  // Where the agent runs the hook from is the repository; the project may be a directory inside it.
  const relative = toProjectPath(repository, root);
  const gate = (prefix: string) => `${prefix}node_modules/.bin/cage gate --root ${prefix}${relative === "" ? "." : relative}`;
  let instructions: string;
  try {
    instructions = fs.readFileSync(INSTRUCTIONS_FILE, "utf8");
  } catch (cause) {
    environment("examples/claude-code/CLAUDE.md", "read", cause);
    return report();
  }
  const addInstructions = (file: string) =>
    put(file, (current) => {
      if (current === undefined) return instructions;
      if (current.includes("cage check")) return undefined;
      return `${current.replace(/\n*$/, "\n\n")}${instructions.replace(/^# /, "## ")}`;
    });

  if (options.agents.includes("claude")) {
    const command = gate('"$CLAUDE_PROJECT_DIR"/');
    put(path.join(repository, ".claude", "settings.json"), (current) => {
      let settings: Record<string, unknown> = {};
      if (current !== undefined) {
        try {
          const parsed: unknown = JSON.parse(stripBom(current));
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("it is not a JSON object");
          settings = parsed as Record<string, unknown>;
        } catch (cause) {
          diagnostics.push({ code: "E_CONFIG", severity: "error", message: `The settings file cannot be changed: ${(cause as Error).message}`, file: toProjectPath(root, path.join(repository, ".claude/settings.json")) });
          return undefined;
        }
      }
      const hooks = (settings.hooks ??= {}) as Record<string, unknown>;
      const stop = (hooks.Stop ??= []) as { hooks?: Record<string, unknown>[] }[];
      if (!Array.isArray(stop)) {
        diagnostics.push({ code: "E_CONFIG", severity: "error", message: 'The settings file cannot be changed: "hooks.Stop" is not an array.', file: toProjectPath(root, path.join(repository, ".claude/settings.json")) });
        return undefined;
      }
      if (stop.some((entry) => entry.hooks?.some((hook) => typeof hook.command === "string" && hook.command.includes("cage gate")))) return undefined;
      stop.push({ hooks: [{ type: "command", command, timeout: 180 }] });
      return `${JSON.stringify(settings, null, 2)}\n`;
    });
    addInstructions(path.join(repository, "CLAUDE.md"));
  }

  if (options.agents.includes("codex")) {
    const block = ["", "# cage: the agent may not finish while `cage check` fails (see CLAUDE.md / AGENTS.md).", "[[hooks.Stop]]", "[[hooks.Stop.hooks]]", 'type = "command"', `command = "${gate("")}"`, "timeout = 180000", ""].join("\n");
    put(path.join(repository, ".codex", "config.toml"), (current) => {
      if (current === undefined) return block.replace(/^\n/, "");
      if (current.includes("cage gate")) return undefined;
      return `${current.replace(/\n*$/, "\n")}${block}`;
    });
    addInstructions(path.join(repository, "AGENTS.md"));
  }
  return report();
}

/** The Git repository that holds the root, or the root when there is none or git is not there. */
function repositoryOf(root: string): string {
  const found = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8", windowsHide: true });
  if (found.error || found.status !== 0) return root;
  const top = path.resolve(found.stdout.trim());
  // A root above the repository (a parent that merely contains it) is its own place.
  return root.startsWith(top) ? top : root;
}

/** Vitest when a package.json of the project or its repository depends on it; node:test otherwise. */
function detectTestAdapter(directories: readonly string[]): "node:test" | "vitest" {
  for (const directory of directories) {
    try {
      const manifest = JSON.parse(stripBom(fs.readFileSync(path.join(directory, "package.json"), "utf8"))) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      if (manifest.devDependencies?.vitest !== undefined || manifest.dependencies?.vitest !== undefined) return "vitest";
    } catch {
      // No manifest here, or not one we can read: look further up.
    }
  }
  return "node:test";
}

export function formatInitReport(report: InitReport): string {
  const lines = report.files.map((file) => `${file.status.padEnd(9)} ${file.path}`);
  lines.push(...report.diagnostics.map((diagnostic) => `${diagnostic.file ? `${diagnostic.file}: ` : ""}${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}`));
  const errors = report.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
  if (errors > 0) {
    lines.push(`init: ${errors} error${errors === 1 ? "" : "s"}.`);
    return `${lines.join("\n")}\n`;
  }
  const where = report.repository === "." ? "" : ` from ${report.repository}`;
  const agents = report.agents.length === 0 ? "no Stop gate set up (--agent claude or codex)" : `Stop gate for ${report.agents.join(" and ")}${where}`;
  lines.push(`init: ${agents}.`);
  lines.push("Next: describe a module in a *.cage.mdx next to its code, tag its implementation with `@implements` and its tests with `@tests` / `@covers`, then run `cage check`.");
  if (report.agents.includes("codex")) lines.push("Codex loads .codex/config.toml of a trusted project; versions before 0.145 need `[features]\\nhooks = true` in it.");
  return `${lines.join("\n")}\n`;
}
