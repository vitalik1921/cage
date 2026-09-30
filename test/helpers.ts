import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { TestContext } from "node:test";
import { defaultConfig } from "../src/config.ts";
import { checkDesignPhase, type DesignPhaseResult } from "../src/design-phase.ts";
import type { Diagnostic } from "../src/diagnostic.ts";
import { discoverDesigns } from "../src/discovery.ts";
import { runCli } from "../src/main.ts";

export const fixturesDir = path.join(import.meta.dirname, "fixtures");

// The vertical fixture holds the three designs of section 13 of the plan.
export const QUOTA = "src/modules/quota/.design/design.mdx";
export const MAIL = "src/modules/mail/.design/design.mdx";
export const CAMPAIGNS = "src/modules/campaigns/.design/design.mdx";
export const generated = (design: string) => design.replace("design.mdx", "design.generated.ts");

export const doc = (...lines: string[]) => lines.join("\n");

/**
 * Copies a fixture project into a scratch directory removed after the test.
 * The copy stays inside the repository so that, like a real project, it
 * resolves `@types/node` from node_modules.
 */
export function copyFixture(t: TestContext, name: string): string {
  const scratch = path.join(import.meta.dirname, ".tmp");
  fs.mkdirSync(scratch, { recursive: true });
  const dir = fs.mkdtempSync(path.join(scratch, `${name}-`));
  fs.cpSync(path.join(fixturesDir, name), dir, { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function writeFile(root: string, file: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
}

export const readFile = (root: string, file: string) => fs.readFileSync(path.join(root, file), "utf8");

export function editFile(root: string, file: string, edit: (text: string) => string): string {
  const before = readFile(root, file);
  const after = edit(before);
  assert.notEqual(after, before, `edit did not change ${file}`);
  fs.writeFileSync(path.join(root, file), after);
  return after;
}

/** Every file under `root` with its content, to assert what a command did or did not touch. */
export function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    files[path.relative(root, file).split(path.sep).join("/")] = fs.readFileSync(file, "utf8");
  }
  return files;
}

/**
 * Reference position of the first line containing `needle`, computed
 * independently of the harness: 1-based line and UTF-16 column.
 */
export function find(text: string, needle: string): { line: number; column: number } {
  const lines = text.split(/\r\n|\r|\n/);
  const index = lines.findIndex((line) => line.includes(needle));
  assert.ok(index >= 0, `"${needle}" not found`);
  return { line: index + 1, column: lines[index].indexOf(needle) + 1 };
}

/** The design phase over the default discovery scope of a project. */
export function checkDesigns(root: string): DesignPhaseResult {
  return checkDesignPhase({ root, tsconfig: defaultConfig.tsconfig, designs: discoverDesigns(root, defaultConfig) });
}

export const summary = ({ code, tsCode, file, line, column }: Diagnostic) => ({ code, tsCode, file, line, column });

/** Runs the CLI in-process with `root` as the working directory. */
export function cli(root: string, ...args: string[]): { code: number; stdout: string; stderr: string } {
  let stdout = "";
  let stderr = "";
  const code = runCli(args, { cwd: root, stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) });
  return { code, stdout, stderr };
}
