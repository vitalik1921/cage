import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { TestContext } from "node:test";
import { defaultConfig, type Config } from "../src/config.ts";
import type { DesignIndex } from "../src/design-model.ts";
import { checkDesignPhase, type DesignPhaseResult } from "../src/design-phase.ts";
import { isError, type Diagnostic } from "../src/diagnostic.ts";
import { discoverDesigns, discoverSources } from "../src/discovery.ts";
import { runExtract } from "../src/extract.ts";
import { checkImplementationPhase, type ImplementationPhaseResult } from "../src/implementation-phase.ts";
import { runCli } from "../src/main.ts";

export const fixturesDir = path.join(import.meta.dirname, "fixtures");

// The vertical fixture holds the three designs of section 13 of the plan.
export const QUOTA = "src/modules/quota/.design/design.mdx";
export const MAIL = "src/modules/mail/.design/design.mdx";
export const CAMPAIGNS = "src/modules/campaigns/.design/design.mdx";
export const generated = (design: string) => design.replace("design.mdx", "design.generated.ts");

export const doc = (...lines: string[]) => lines.join("\n");

/** Position of `needle` in a file of the plan fixture as committed, for expectations about the unedited fixture. */
export const inFixture = (file: string, needle: string) => ({ file, ...find(fs.readFileSync(path.join(fixturesDir, "vertical", file), "utf8"), needle) });

/** Where the fixture's one warning points: the contract without invariants. */
export const senderWarning = () => {
  const { file, line, column } = inFixture(MAIL, "Sender {");
  return `${file}:${line}:${column}: warning W_NO_INVARIANTS: Contract "Sender" has no \`@invariant\`: only its types can be checked.`;
};

/**
 * A scratch directory removed after the test. It is inside the repository so
 * that a project in it, like a real one, resolves `@types/node` and
 * `typescript` from node_modules.
 */
function scratchDirectory(t: TestContext, name: string): string {
  const scratch = path.join(import.meta.dirname, ".tmp");
  fs.mkdirSync(scratch, { recursive: true });
  const dir = fs.mkdtempSync(path.join(scratch, `${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Copies a fixture project into a scratch directory. */
export function copyFixture(t: TestContext, name: string): string {
  const dir = scratchDirectory(t, name);
  fs.cpSync(path.join(fixturesDir, name), dir, { recursive: true });
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

/**
 * The design phase over the default discovery scope of a project. Reading
 * `index` asserts that the designs were indexed; `errors` are the diagnostics
 * without warnings.
 */
export function checkDesigns(root: string): DesignPhaseResult & { index: DesignIndex; errors: Diagnostic[] } {
  const result = checkDesignPhase({ root, tsconfig: defaultConfig.tsconfig, designs: discoverDesigns(root, defaultConfig) });
  return {
    ...result,
    errors: result.diagnostics.filter(isError),
    get index() {
      assert.ok(result.index, "the designs were not indexed");
      return result.index;
    },
  };
}

export const summary = ({ code, tsCode, file, line, column }: Diagnostic) => ({ code, tsCode, file, line, column });
export const located = ({ code, file, line, column }: Diagnostic) => ({ code, file, line, column });

export { isError };

/** The errors of the design phase, without warnings. */
export const designErrors = (root: string) => checkDesigns(root).errors;

/** A design document: a title, a line of prose, and the given `ts design` blocks. */
export const mdx = (...blocks: string[]) => ["# Module", "", "What the module is for.", "", ...blocks.flatMap((block) => ["```ts design", block, "```", ""])].join("\n");

/** A valid contract declaration; `tags` are extra doc lines, `body` the members. */
export const contract = (name: string, body = "run(): void;", ...tags: string[]) =>
  ["/**", " * @contract", ` * @description ${name}.`, ...tags.map((tag) => ` * ${tag}`), " */", `export interface ${name} {`, `  ${body}`, "}"].join("\n");

/** A valid data type declaration. */
export const data = (name: string, type = "string") => ["/**", " * @data", ` * @description ${name}.`, " */", `export type ${name} = ${type};`].join("\n");

export const designFile = (module: string) => `src/${module}/.design/design.mdx`;

/** The compiler options of a `designProject`. */
export const PROJECT_OPTIONS = { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, allowImportingTsExtensions: true };

/**
 * A small project removed after the test: `designs` maps a module name to the
 * text of its design document, stored at `src/<module>/.design/design.mdx`.
 */
export function designProject(t: TestContext, designs: Record<string, string>, files: Record<string, string> = {}): string {
  const root = scratchDirectory(t, "designs");
  writeFile(root, "package.json", JSON.stringify({ private: true, type: "module" }));
  writeFile(root, "tsconfig.json", JSON.stringify({ compilerOptions: PROJECT_OPTIONS }));
  for (const [module, text] of Object.entries(designs)) writeFile(root, designFile(module), text);
  // Given files come last, so that a test can replace the defaults above.
  for (const [file, text] of Object.entries(files)) writeFile(root, file, text);
  return root;
}

/** Error diagnostics of a design project as `code line:column`, where the position is that of `needle` in the module's document. */
export const at = (root: string, module: string, needle: string, offset = 0) => {
  const position = find(readFile(root, designFile(module)), needle);
  return { file: designFile(module), line: position.line, column: position.column + offset };
};

/**
 * The implementation phase over the default scope of a project, after its
 * generated files were written, so that only the mistakes a test sets up are
 * reported. `linking` asserts that the phase got past the designs.
 */
export function checkLinking(
  root: string,
  testAdapter: Config["testAdapter"] = defaultConfig.testAdapter,
): Omit<ImplementationPhaseResult, "linking"> & { linking: NonNullable<ImplementationPhaseResult["linking"]>; errors: Diagnostic[] } {
  const scope = { root, tsconfig: defaultConfig.tsconfig, designs: discoverDesigns(root, defaultConfig) };
  runExtract(scope, false);
  const result = checkImplementationPhase({ ...scope, sources: discoverSources(root, defaultConfig), testAdapter, generatedFiles: true });
  return {
    ...result,
    errors: result.diagnostics.filter(isError),
    get linking() {
      assert.ok(result.linking, "the implementation phase stopped at the designs");
      return result.linking;
    },
  };
}

/** Position of `needle` in a source file of a project. */
export const inFile = (root: string, file: string, needle: string, offset = 0) => {
  const position = find(readFile(root, file), needle);
  return { file, line: position.line, column: position.column + offset };
};

/** Runs the CLI in-process with `root` as the working directory. */
export function cli(root: string, ...args: string[]): { code: number; stdout: string; stderr: string } {
  return cliWithStdin(root, undefined, ...args);
}

/** The CLI with something piped in, as a hook gets it. */
export function cliWithStdin(root: string, stdin: string | undefined, ...args: string[]): { code: number; stdout: string; stderr: string } {
  let stdout = "";
  let stderr = "";
  const code = runCli(args, { cwd: root, stdin, stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) });
  return { code, stdout, stderr };
}
