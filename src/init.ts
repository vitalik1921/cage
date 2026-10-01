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
/** The skills shipped with the package: how to design a module and how to review one. */
const SKILLS_DIRECTORY = new URL("../examples/skills/", import.meta.url);
const SKILLS = ["cage-design", "cage-review"] as const;
/** Seconds: long enough for the compiler on a large project, short enough not to hold a session. */
const GATE_TIMEOUT = 180;

/**
 * `cage init`: the first configuration, and the Stop gate of the agent's
 * environment. Everything is written once: a file that is already there is
 * kept, a settings file that has other hooks gets the gate added, and a
 * second run changes nothing. The agent's files go to the Git repository
 * that holds the project; the hook names the project and the installed
 * `cage`, so a project inside a monorepo works.
 */
export function runInit(options: InitOptions): InitReport {
  const root = realpath(path.resolve(options.root));
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
  const shown = (file: string) => toProjectPath(root, file);
  const problem = (code: "E_CONFIG" | "E_ENVIRONMENT" | "W_GATE_COMMAND", severity: "error" | "warning", file: string | undefined, message: string) => {
    diagnostics.push({ code, severity, message, ...(file === undefined ? {} : { file: shown(file) }) });
  };

  /**
   * Writes a file once: `text` is the content for a file that is not there;
   * `update` the content for one that is, or undefined to keep it. Files a
   * person authored are written in place, so that a symbolic link or a file
   * mode stays what it is.
   */
  const put = (file: string, text: string, update: (current: string) => string | undefined | Error, inPlace = true) => {
    let current: string | undefined;
    try {
      current = fs.readFileSync(file, "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") return problem("E_ENVIRONMENT", "error", file, `Cannot read ${shown(file)}: ${(cause as Error).message}`);
    }
    const next = current === undefined ? text : update(current);
    if (next instanceof Error) return problem("E_CONFIG", "error", file, `${shown(file)} cannot be changed: ${next.message}`);
    if (next === undefined) return files.push({ path: shown(file), status: "kept" });
    try {
      if (inPlace && current !== undefined) fs.writeFileSync(file, next);
      else writeRecordFile(file, next);
      files.push({ path: shown(file), status: current === undefined ? "created" : "updated" });
    } catch (cause) {
      problem("E_ENVIRONMENT", "error", file, `Cannot write ${shown(file)}: ${(cause as Error).message}`);
    }
  };

  // The configuration: the detected runner and both levels spelled out, so that the project sees what it can change.
  const configFile = path.join(root, DEFAULT_CONFIG_FILE);
  if (!fs.existsSync(configFile)) {
    const testAdapter = options.testAdapter ?? detectTestAdapter([root, repository]);
    // NestJS projects name their end-to-end tests `*.e2e-spec.ts`; they are tests, not code.
    const tests = testAdapter === "vitest" ? ["src/**/*.{test,spec,e2e-spec}.ts", "tests/**/*.{test,spec,e2e-spec}.ts"] : ["src/**/*.test.ts", "tests/**/*.test.ts"];
    put(configFile, `${JSON.stringify({ version: 1, tests, testAdapter, review: "warn", coverage: "warn" }, null, 2)}\n`, () => undefined, false);
  } else {
    files.push({ path: shown(configFile), status: "kept" });
  }
  if (options.agents.length === 0 || hasErrors(diagnostics)) return report();

  // The hook runs from the repository: it names the project and the `cage` that is installed, wherever that is.
  const bin = installedBin(root, repository);
  if (bin === undefined) {
    problem("W_GATE_COMMAND", "warning", undefined, `No installed \`cage\` was found between ${shown(root) || "."} and the repository; the hook expects node_modules/.bin/cage at the repository root. Install cage-ts there, or edit the hook command.`);
  }
  const binPath = bin ?? "node_modules/.bin/cage";
  const projectPath = toProjectPath(repository, root) || ".";
  const claudeCommand = `"$CLAUDE_PROJECT_DIR/${binPath}" gate --root "$CLAUDE_PROJECT_DIR/${projectPath}"`;
  const codexCommand = `"${binPath}" gate --root "${projectPath}"`;
  /** Whether a hook command already gates this project, however it quotes its paths and wherever its `cage` is. */
  const gatesProject = (command: string, prefix: string) => {
    const plain = command.replaceAll('"', "").replaceAll("'", "").trim();
    const target = `${prefix}${projectPath}`;
    return /\bcage gate\b/.test(plain) && (plain.endsWith(`--root ${target}`) || (projectPath === "." && plain.endsWith(`--root ${prefix.replace(/\/$/, "")}`)));
  };

  let instructions: string;
  try {
    instructions = fs.readFileSync(INSTRUCTIONS_FILE, "utf8");
  } catch (cause) {
    problem("E_ENVIRONMENT", "error", undefined, `Cannot read the agent instructions shipped with cage (${INSTRUCTIONS_FILE.pathname}): ${(cause as Error).message}`);
    return report();
  }
  /** Copies each shipped skill into the environment's skills directory; a skill that is already there is the project's and is kept. */
  const addSkills = (directory: string) => {
    for (const skill of SKILLS) {
      let text: string;
      try {
        text = fs.readFileSync(new URL(`${skill}/SKILL.md`, SKILLS_DIRECTORY), "utf8");
      } catch (cause) {
        problem("E_ENVIRONMENT", "error", undefined, `Cannot read the skill shipped with cage (${new URL(`${skill}/SKILL.md`, SKILLS_DIRECTORY).pathname}): ${(cause as Error).message}`);
        return;
      }
      put(path.join(directory, skill, "SKILL.md"), text, () => undefined, false);
    }
  };
  const addInstructions = (file: string) =>
    put(file, instructions, (current) => {
      if (current.includes("cage check")) return undefined;
      const eol = current.includes("\r\n") ? "\r\n" : "\n";
      const section = instructions.replace(/^# /, "## ").replaceAll("\n", eol);
      return `${current.replace(/(\r?\n)*$/, "")}${eol}${eol}${section}`;
    });

  if (options.agents.includes("claude")) {
    const entry = { hooks: [{ type: "command", command: claudeCommand, timeout: GATE_TIMEOUT }] };
    put(path.join(repository, ".claude", "settings.json"), `${JSON.stringify({ hooks: { Stop: [entry] } }, null, 2)}\n`, (current) => {
      try {
        const settings = asObject(JSON.parse(stripBom(current)), "the file");
        const hooks = settings.hooks === undefined ? (settings.hooks = {}) : settings.hooks;
        if (!isObject(hooks)) throw new Error('"hooks" is not an object');
        const stop = hooks.Stop === undefined ? (hooks.Stop = []) : hooks.Stop;
        if (!Array.isArray(stop)) throw new Error('"hooks.Stop" is not an array');
        const commands = stop.flatMap((group: unknown) => {
          if (!isObject(group)) throw new Error('an entry of "hooks.Stop" is not an object');
          const handlers = group.hooks ?? [];
          if (!Array.isArray(handlers)) throw new Error('"hooks" of a "hooks.Stop" entry is not an array');
          return handlers.map((handler: unknown) => (isObject(handler) ? handler.command : undefined));
        });
        // The same project is gated once; another project of the repository gets its own entry.
        if (commands.some((command) => typeof command === "string" && gatesProject(command, "$CLAUDE_PROJECT_DIR/"))) return undefined;
        stop.push(entry);
        return `${JSON.stringify(settings, null, 2)}\n`;
      } catch (cause) {
        return cause as Error;
      }
    });
    if (hasErrors(diagnostics)) return report();
    addInstructions(path.join(repository, "CLAUDE.md"));
    addSkills(path.join(repository, ".claude", "skills"));
  }

  if (options.agents.includes("codex")) {
    const block = [
      "# cage: the agent may not finish while `cage check` fails (see AGENTS.md).",
      "[[hooks.Stop]]",
      "[[hooks.Stop.hooks]]",
      'type = "command"',
      `command = '${codexCommand}'`,
      `timeout = ${GATE_TIMEOUT}`,
      "",
    ].join("\n");
    put(path.join(repository, ".codex", "config.toml"), block, (current) => {
      if (current.split(/\r?\n/).some((line) => /^\s*command\s*=/.test(line) && gatesProject(line.replace(/^\s*command\s*=\s*/, ""), ""))) return undefined;
      // A `[hooks]` table, or hooks given inline, cannot take an array-of-tables entry after it.
      if (/^\s*\[hooks\]|^\s*hooks\s*=/m.test(current)) return new Error(`it defines "hooks" in a form this command cannot add to; add the Stop hook by hand:\n${block}`);
      const eol = current.includes("\r\n") ? "\r\n" : "\n";
      return `${current.replace(/(\r?\n)*$/, "")}${eol}${eol}${block.replaceAll("\n", eol)}`;
    });
    if (hasErrors(diagnostics)) return report();
    addInstructions(path.join(repository, "AGENTS.md"));
    // Codex reads repository skills from .agents/skills.
    addSkills(path.join(repository, ".agents", "skills"));
  }
  return report();
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
function asObject(value: unknown, what: string): Record<string, unknown> {
  if (!isObject(value)) throw new Error(`${what} is not a JSON object`);
  return value;
}

const realpath = (file: string) => {
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
};

/** The Git repository that holds the root, or the root when there is none or git is not there. */
function repositoryOf(root: string): string {
  const found = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8", windowsHide: true });
  if (found.error || found.status !== 0) return root;
  const top = realpath(path.resolve(found.stdout.trim()));
  const inside = path.relative(top, root);
  return inside === "" || (!inside.startsWith("..") && !path.isAbsolute(inside)) ? top : root;
}

/** The `cage` bin nearest to the project, between it and the repository, as a path from the repository; undefined when none is installed. */
function installedBin(root: string, repository: string): string | undefined {
  const name = process.platform === "win32" ? "cage.cmd" : "cage";
  for (let directory = root; ; directory = path.dirname(directory)) {
    const bin = path.join(directory, "node_modules", ".bin", name);
    if (fs.existsSync(bin)) return path.relative(repository, bin).split(path.sep).join("/");
    if (directory === repository || path.dirname(directory) === directory) return undefined;
  }
}

/** Vitest when a package.json of the project or its repository depends on it; node:test otherwise. */
function detectTestAdapter(directories: readonly string[]): "node:test" | "vitest" {
  for (const directory of [...new Set(directories)]) {
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
    lines.push(`init: ${errors} error${errors === 1 ? "" : "s"}; what is listed above as created or updated was written before it.`);
    return `${lines.join("\n")}\n`;
  }
  const where = report.repository === "." ? "" : `, its files at the repository root (${report.repository})`;
  const agents = report.agents.length === 0 ? "no Stop gate set up (--agent claude or codex)" : `Stop gate for ${report.agents.join(" and ")}${where}`;
  lines.push(`init: ${agents}.`);
  lines.push("Next: describe a module in a *.cage.mdx next to its code, tag its implementation with `@implements` and its tests with `@tests` / `@covers`, then run `cage check`.");
  if (report.agents.includes("codex")) {
    lines.push("Codex loads .codex/config.toml of a trusted project; versions before 0.145 need `[features]` with `codex_hooks = true` in it (later ones have hooks on by default).");
  }
  return `${lines.join("\n")}\n`;
}
