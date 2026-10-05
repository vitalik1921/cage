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
const INSTRUCTIONS_FILE = new URL("../plugin/rules.md", import.meta.url);
/** The skills shipped with the package: how to design a module and how to review one. */
const SKILLS_DIRECTORY = new URL("../plugin/skills/", import.meta.url);
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
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") return problem("E_ENVIRONMENT", "error", file, `cannot read ${shown(file)}: ${(cause as Error).message}`);
    }
    const next = current === undefined ? text : update(current);
    if (next instanceof Error) return problem("E_CONFIG", "error", file, `${shown(file)} cannot be changed: ${next.message}`);
    if (next === undefined) return files.push({ path: shown(file), status: "kept" });
    try {
      if (inPlace && current !== undefined) fs.writeFileSync(file, next);
      else writeRecordFile(file, next);
      files.push({ path: shown(file), status: current === undefined ? "created" : "updated" });
    } catch (cause) {
      problem("E_ENVIRONMENT", "error", file, `cannot write ${shown(file)}: ${(cause as Error).message}`);
    }
  };

  // The configuration: the detected runner and both levels spelled out, so that the project sees what it can change.
  const configFile = path.join(root, DEFAULT_CONFIG_FILE);
  if (!fs.existsSync(configFile)) {
    const testAdapter = options.testAdapter ?? detectTestAdapter([root, repository]);
    // NestJS projects name their end-to-end tests `*.e2e-spec.ts`; they are tests, not code.
    const tests = testAdapter === "vitest" ? ["src/**/*.{test,spec,e2e-spec}.ts", "tests/**/*.{test,spec,e2e-spec}.ts"] : ["src/**/*.test.ts", "tests/**/*.test.ts"];
    put(configFile, `${JSON.stringify({ version: 1, tests, testAdapter, review: "warn", coverage: "warn", maxDiagnostics: 50 }, null, 2)}\n`, () => undefined, false);
  } else {
    files.push({ path: shown(configFile), status: "kept" });
  }
  if (options.agents.length === 0 || hasErrors(diagnostics)) return report();

  // The hook runs from the repository: it names the project and the `cage` that is installed, wherever that is.
  const bin = installedBin(root, repository);
  if (bin === undefined) {
    problem("W_GATE_COMMAND", "warning", undefined, `no installed cage between ${shown(root) || "."} and the repository (node_modules/.bin/cage)`);
  }
  const binPath = bin ?? "node_modules/.bin/cage";
  const projectPath = toProjectPath(repository, root) || ".";
  // The paths are data: single-quoted for the shell, so that no `$`, backtick or quote in a directory name is
  // expanded or ends the word. The project directory of Claude Code is the one variable, double-quoted.
  const claudeCommand = `"$CLAUDE_PROJECT_DIR"/${shellWord(binPath)} gate --root "$CLAUDE_PROJECT_DIR"/${shellWord(projectPath)}`;
  const codexCommand = `${shellWord(binPath)} gate --root ${shellWord(projectPath)}`;
  /** Whether a hook command runs `cage gate` for this project: parsed as the shell would, never by its mere text. */
  const gatesProject = (command: string, base: "$CLAUDE_PROJECT_DIR" | "") => runsGate(command, base, projectPath);
  /** A hook that is not the gate but looks like one: kept as it is, and said, since it may be a gate gone wrong. */
  const nearMiss = (file: string, command: string, under: "$CLAUDE_PROJECT_DIR" | "") => {
    // Another project's gate in the same repository is a gate: nothing to say about it.
    if (!/\bcage\b/.test(command) || !/\bgate\b/.test(command) || runsGate(command, under, undefined)) return;
    problem("W_GATE_COMMAND", "warning", file, `Stop hook ${JSON.stringify(command)} mentions cage gate but is not the gate of ${projectPath}; kept, the gate added beside it`);
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
  // The rules go in once, behind a marker that says whose they are; a file an earlier init wrote has their heading.
  // A mention of `cage check` elsewhere in the file is the project's prose, not the rules.
  const hasRules = (text: string) => text.includes(RULES_MARKER) || /^#{1,2} Contract harness\b/m.test(text);
  const addInstructions = (file: string) =>
    put(file, `${RULES_MARKER}\n${instructions}`, (current) => {
      if (hasRules(current)) return undefined;
      const eol = current.includes("\r\n") ? "\r\n" : "\n";
      const section = `${RULES_MARKER}\n${instructions.replace(/^# /, "## ")}`.replaceAll("\n", eol);
      return `${current.replace(/(\r?\n)*$/, "")}${eol}${eol}${section}`;
    });

  if (options.agents.includes("claude")) {
    const entry = { hooks: [{ type: "command", command: claudeCommand, timeout: GATE_TIMEOUT }] };
    const settingsFile = path.join(repository, ".claude", "settings.json");
    put(settingsFile, `${JSON.stringify({ hooks: { Stop: [entry] } }, null, 2)}\n`, (current) => {
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
        // The same project is gated once; another project of the repository gets its own entry. Other hooks stay.
        if (commands.some((command) => typeof command === "string" && gatesProject(command, "$CLAUDE_PROJECT_DIR"))) return undefined;
        for (const command of commands) if (typeof command === "string") nearMiss(settingsFile, command, "$CLAUDE_PROJECT_DIR");
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
      `command = ${tomlString(codexCommand)}`,
      `timeout = ${GATE_TIMEOUT}`,
      "",
    ].join("\n");
    const codexFile = path.join(repository, ".codex", "config.toml");
    put(codexFile, block, (current) => {
      const commands = current.split(/\r?\n/).flatMap((line) => {
        const value = /^\s*command\s*=\s*(.*)$/.exec(line)?.[1];
        return value === undefined ? [] : [tomlStringValue(value) ?? value];
      });
      if (commands.some((command) => gatesProject(command, ""))) return undefined;
      for (const command of commands) nearMiss(codexFile, command, "");
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

/** What starts the rules in CLAUDE.md or AGENTS.md: how a later init knows they are there, whatever was edited around and in them. */
const RULES_MARKER = "<!-- cage:rules -->";

/** A word for a POSIX shell that is data whatever it holds: single-quoted, each `'` closed, escaped and reopened. */
const shellWord = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

/** A TOML basic string: the quote, the backslash and control characters escaped, everything else as it is. */
function tomlString(text: string): string {
  const escaped = [...text].map((character) => {
    const code = character.codePointAt(0)!;
    if (character === '"' || character === "\\") return `\\${character}`;
    return code < 0x20 || code === 0x7f ? `\\u${code.toString(16).padStart(4, "0")}` : character;
  });
  return `"${escaped.join("")}"`;
}

/** The value of a one-line TOML string, literal or basic, with a comment after it allowed; undefined for anything else. */
function tomlStringValue(raw: string): string | undefined {
  const text = raw.trim();
  const rest = (end: number) => /^\s*(#.*)?$/.test(text.slice(end));
  if (text.startsWith("'''") || text.startsWith('"""')) return undefined;
  if (text.startsWith("'")) {
    const end = text.indexOf("'", 1);
    return end > 0 && rest(end + 1) ? text.slice(1, end) : undefined;
  }
  if (!text.startsWith('"')) return undefined;
  const simple: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", e: "\u001b", '"': '"', "\\": "\\" };
  let value = "";
  for (let index = 1; index < text.length; index++) {
    const character = text[index];
    if (character === '"') return rest(index + 1) ? value : undefined;
    if (character !== "\\") {
      value += character;
      continue;
    }
    const next = text[++index];
    if (next !== undefined && Object.hasOwn(simple, next)) value += simple[next];
    else if (next === "u" || next === "U") {
      const digits = text.slice(index + 1, index + (next === "u" ? 5 : 9));
      if (!/^[0-9a-fA-F]+$/.test(digits) || digits.length !== (next === "u" ? 4 : 8)) return undefined;
      value += String.fromCodePoint(Number.parseInt(digits, 16));
      index += digits.length;
    } else return undefined;
  }
  return undefined;
}

/** Where `$CLAUDE_PROJECT_DIR` stood in a parsed command: a character no path holds, so a `$` written in quotes stays data. */
const PROJECT_DIR = "\u0000";

/**
 * The words of a shell command with its quotes removed, `$CLAUDE_PROJECT_DIR` as `PROJECT_DIR`. Undefined for
 * anything else a shell would act on — another expansion, a substitution, a separator, a redirection, a glob, a
 * comment — since what such a command does is not what its words say.
 */
function shellWords(command: string): string[] | undefined {
  const words: string[] = [];
  let word: string | undefined;
  let index = 0;
  const add = (text: string) => (word = (word ?? "") + text);
  const variable = () => {
    const found = /^\$(?:CLAUDE_PROJECT_DIR(?![A-Za-z0-9_])|\{CLAUDE_PROJECT_DIR\})/.exec(command.slice(index));
    if (!found) return false;
    add(PROJECT_DIR);
    index += found[0].length;
    return true;
  };
  while (index < command.length) {
    const character = command[index];
    if (/\s/.test(character)) {
      if (word !== undefined) words.push(word);
      word = undefined;
      index++;
    } else if (character === "'") {
      const end = command.indexOf("'", index + 1);
      if (end < 0) return undefined;
      add(command.slice(index + 1, end));
      index = end + 1;
    } else if (character === '"') {
      add("");
      for (index++; ; ) {
        if (index >= command.length) return undefined;
        const inner = command[index];
        if (inner === '"') {
          index++;
          break;
        }
        if (inner === "`") return undefined;
        if (inner === "$") {
          if (!variable()) return undefined;
          continue;
        }
        if (inner === "\\" && index + 1 < command.length && '$`"\\\n'.includes(command[index + 1])) {
          add(command[index + 1]);
          index += 2;
          continue;
        }
        add(inner);
        index++;
      }
    } else if (character === "\\") {
      if (index + 1 >= command.length) return undefined;
      add(command[index + 1]);
      index += 2;
    } else if (character === "$") {
      if (!variable()) return undefined;
    } else if (/[;&|<>()`#*?[\]{}~!]/.test(character)) {
      return undefined;
    } else {
      add(character);
      index++;
    }
  }
  if (word !== undefined) words.push(word);
  return words;
}

/**
 * Whether a hook command runs `cage gate` for the project at `projectPath`: an installed `cage` as the command,
 * `gate`, the options of gate, and `--root` naming the project — under `base` (`$CLAUDE_PROJECT_DIR`) or, for
 * Codex, relative to the repository; any project of the repository when `projectPath` is undefined. A command that
 * only mentions `cage gate` is not one.
 */
function runsGate(command: string, under: "$CLAUDE_PROJECT_DIR" | "", projectPath: string | undefined): boolean {
  const base = under === "" ? "" : PROJECT_DIR;
  const words = shellWords(command);
  if (!words || words.length < 2 || !/(^|\/)cage(\.cmd)?$/.test(words[0]) || words[1] !== "gate") return false;
  let root: string | undefined;
  for (let index = 2; index < words.length; index++) {
    const word = words[index];
    if (word.startsWith("--root=")) root = word.slice("--root=".length);
    else if ((word === "--root" || word === "--base" || word === "--config") && index + 1 < words.length) {
      if (word === "--root") root = words[index + 1];
      index++;
    } else return false;
  }
  if (root === undefined) return false;
  let relative: string;
  if (base === "") {
    if (root.includes(PROJECT_DIR) || path.posix.isAbsolute(root)) return false;
    relative = root;
  } else {
    if (!root.startsWith(base) || (root.length > base.length && root[base.length] !== "/")) return false;
    relative = root.slice(base.length + 1);
  }
  return projectPath === undefined || path.posix.normalize(relative || ".") === path.posix.normalize(projectPath);
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
