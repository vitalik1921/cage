// Builds and packs the package, installs the tarball into scratch projects outside the repository and drives the
// installed `cage` through what the review of 2026-10-05 found: hook commands with paths a shell or TOML would
// misread, hooks and rules that only look like cage's, review material behind a link out of the project, setup
// around tests in blocks and loops, dependencies that cannot be read, incomplete verdicts, value imports of types,
// and the formats of review. Every step asserts; the evidence goes to test/.tmp/e2e-evidence/.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repository = path.resolve(import.meta.dirname, "..");
const evidence = path.join(repository, "test/.tmp/e2e-evidence");
fs.rmSync(evidence, { recursive: true, force: true });
fs.mkdirSync(evidence, { recursive: true });
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cage-e2e-")));
const passed = [];
const log = (name, text) => fs.writeFileSync(path.join(evidence, `${name}.txt`), text);
const pass = (name, detail) => {
  passed.push(name);
  console.log(`PASS ${name}${detail ? `: ${detail}` : ""}`);
};
const sh = (command, args, options = {}) => spawnSync(command, args, { encoding: "utf8", ...options });

try {
  // ---- The package as npm ships it, installed once; every project below gets a copy of that install.
  execFileSync("npm", ["run", "build", "--silent"], { cwd: repository, stdio: "inherit" });
  const tarball = path.join(scratch, execFileSync("npm", ["pack", "--pack-destination", scratch, "--silent"], { cwd: repository, encoding: "utf8" }).trim().split("\n").pop());
  const base = path.join(scratch, "base");
  fs.cpSync(path.join(repository, "test/fixtures/vertical"), base, { recursive: true });
  const types = JSON.parse(fs.readFileSync(path.join(repository, "package.json"), "utf8")).devDependencies["@types/node"];
  execFileSync("npm", ["install", "--silent", "--no-audit", "--no-fund", "--no-package-lock", tarball, `@types/node@${types}`], { cwd: base, stdio: "inherit" });
  const probe = path.join(scratch, "print-node.cjs");
  fs.writeFileSync(probe, "process.stderr.write(`node ${process.version} ${process.execPath}\\n`);\n");
  const runtime = sh(path.join(base, "node_modules/.bin/cage"), ["--version"], { cwd: base, env: { ...process.env, NODE_OPTIONS: `--require=${probe}` } });
  log("00-runtime", `tarball ${path.basename(tarball)}\ncage --version ${runtime.stdout}installed bin runs on: ${runtime.stderr}scratch ${scratch}\n`);
  assert.match(runtime.stderr, /^node v26\./m, runtime.stderr);
  pass("pack and install", `${path.basename(tarball)}, bin on ${runtime.stderr.trim()}`);

  const project = (name, from = base) => {
    const root = path.join(scratch, name);
    fs.cpSync(from, root, { recursive: true, verbatimSymlinks: true });
    assert.equal(sh("git", ["init", "--quiet"], { cwd: root }).status, 0);
    return root;
  };
  const cage = (root, ...args) => sh(path.join(root, "node_modules/.bin/cage"), args, { cwd: root, input: "" });
  const json = (run) => JSON.parse(run.stdout);

  // Exact API checks must also work from the installed tarball, including the gate and static bindings.
  const surface = project("exact-public-surface");
  const surfaceFile = path.join(surface, "src/modules/quota/memory-quota.ts");
  const surfaceSource = fs.readFileSync(surfaceFile, "utf8");
  const surfaceRuns = [];
  for (const [label, text, expected] of [
    ["extra public method", surfaceSource.replace("export class MemoryQuota {", "export class MemoryQuota {\n  surplus(): void {}"), "E_CONTRACT_EXTRA_MEMBER"],
    ["extra optional parameter", surfaceSource.replace("take(accountId: string)", "take(accountId: string, extra?: number)"), "E_CONTRACT_SIGNATURE"],
    ["private helper", surfaceSource.replace("export class MemoryQuota {", "export class MemoryQuota {\n  private surplus(): void {}"), null],
    ["undeclared static method", surfaceSource.replace("export class MemoryQuota {", 'export class MemoryQuota {\n  static create(): string { return "quota"; }'), "E_CONTRACT_EXTRA_MEMBER"],
  ]) {
    fs.writeFileSync(surfaceFile, text);
    const checked = cage(surface, "check", "--format", "json");
    assert.equal(checked.status, expected ? 1 : 0, checked.stdout);
    if (expected) assert.ok(json(checked).diagnostics.some(d => d.code === expected), checked.stdout);
    assert.equal(cage(surface, "gate").status, expected ? 2 : 0);
    surfaceRuns.push(`${label}: ${expected ?? "passes"}`);
  }
  fs.appendFileSync(path.join(surface, "src/modules/quota/quota.cage.mdx"), '\n```ts design\n/** @contract\n * @description Static factory name. */\nexport interface Factory { create(): string; }\n```\n');
  fs.writeFileSync(surfaceFile, surfaceSource.replace("/** @implements Quota */", "/** @implements Quota\n * @implements-static Factory */").replace("export class MemoryQuota {", 'export class MemoryQuota {\n  static create(): string { return "quota"; }'));
  const boundStatic = cage(surface, "check", "--format", "json");
  assert.equal(boundStatic.status, 0, boundStatic.stdout);
  surfaceRuns.push("declared static method: passes");
  log("01-exact-public-surface", surfaceRuns.join("\n"));
  pass("exact public contracts", "installed check and gate reject extra members/signature drift; private helpers and explicitly bound static API pass");

  // The installed CLI must load the project's compiler, including TS5, and retain honest test status counts.
  const matrixBase = project("compiler-matrix-base");
  execFileSync("npm", ["install", "--silent", "--no-audit", "--no-fund", "--no-package-lock", "vitest@1.6.1", "zod@3.25.76"], { cwd: matrixBase, stdio: "inherit" });
  for (const [compiler, version] of [["typescript-5", "5.9.3"], ["typescript", "6.0.3"]]) {
    const root = project(`structural-${version}`, matrixBase);
    fs.rmSync(path.join(root, "src"), { recursive: true });
    fs.rmSync(path.join(root, ".cage"), { recursive: true, force: true });
    fs.mkdirSync(path.join(root, "src"));
    fs.mkdirSync(path.join(root, ".cage"));
    fs.rmSync(path.join(root, "node_modules/typescript"), { recursive: true });
    fs.cpSync(path.join(repository, "node_modules", compiler), path.join(root, "node_modules/typescript"), { recursive: true });
    const write = (file, text) => fs.writeFileSync(path.join(root, file), text);
    const design = (...contracts) => write("src/api.cage.mdx", `# API\n\nPublic structural boundary.\n\n\`\`\`ts design\n${contracts.join("\n")}\n\`\`\`\n`);
    const contract = (name, body, invariant = "") => `/** @contract\n * @description ${name}.\n${invariant ? ` * @invariant ${invariant}\n` : ""} */\nexport interface ${name}{${body}}`;
    const config = adapter => write(".cage/config.json", JSON.stringify({ version: 1, review: "off", coverage: "require", testAdapter: adapter }));
    const check = expected => {
      const result = cage(root, "check", "--format", "json", "--max-diagnostics", "all");
      assert.equal(result.status, expected ? 1 : 0, result.stdout + result.stderr);
      const report = json(result);
      assert.equal(report.scope.typescript.version, version, result.stdout);
      assert.equal(report.scope.typescript.source, "project", result.stdout);
      if (expected) assert.ok(report.diagnostics.some(d => d.code === expected), result.stdout);
      assert.equal(cage(root, "gate").status, expected ? 2 : 0);
      return report;
    };
    for (const adapter of ["node:test", "vitest"]) {
      config(adapter);
      design(contract("Action", "run():void;", "linked A test declares this requirement."));
      write("src/impl.ts", '/** @implements Action */\nexport class Action {run():void{}}');
      for (const declaration of ['test.skip("planned",()=>{});', 'test.todo("planned");', 'test("planned",{skip:true},()=>{});', 'test("planned",{todo:true},()=>{});']) {
        write("src/api.test.ts", `import {test} from "${adapter}";\n/** @tests Action\n * @covers linked */\n${declaration}`);
        const report = check(null);
        assert.equal(report.counts.linkedInvariants, 1);
        assert.equal(report.counts.activeInvariants, 0);
        assert.equal(report.counts.activeTestDeclarations, 0);
        assert.equal(report.counts.executedTests, null);
        assert.ok(!report.diagnostics.some(d => d.code.endsWith("TEST_INACTIVE")));
      }
      write("src/api.test.ts", `import {test} from "${adapter}";\n/** @tests Action\n * @covers linked */\ntest("unintended empty",()=>{});`);
      check("E_TEST_INACTIVE");
      write("src/api.test.ts", `import {test} from "${adapter}";import {missing} from "./missing.js";\n/** @tests Action\n * @covers linked */\ntest.skip("broken import",()=>{missing()});`);
      check("E_TEST_INACTIVE");
      pass(`explicit skip/todo ${adapter} TS${version}`, "check/gate pass; inactive counts stay zero-active; empty and broken-import controls block");
    }
    fs.rmSync(path.join(root, "src/api.test.ts"));
    config("node:test");
    design('/** @data\n * @description Callable base. */\nexport interface Call {(value:string):void;}', '/** @data\n * @description Named base. */\nexport interface Named {label:string;}', contract("NamedCall extends Call, Named", ""));
    write("src/impl.ts", '/** @implements NamedCall */\nexport const action=Object.assign((value:string):void=>{}, {label:""});');
    check(null);
    write("src/impl.ts", '/** @implements NamedCall */\nexport const action=Object.assign((value:string,extra?:number):void=>{}, {label:""});');
    check("E_CONTRACT_SIGNATURE");
    pass(`contract inheritance TS${version}`, "one binding inherits callable and fields; extra optional parameter blocks");
    write("src/impl.ts", '/** @implements NamedCall NamedCall */\nexport const action=Object.assign((value:string):void=>{}, {label:""});');
    check("E_TAG_FORMAT");
    design(contract("Action", "run():void;"));
    write("src/impl.ts", '/** @implements Action */\nexport class Action {run():void{}}\n/** @implements Action */\nexport const second={run():void{}};');
    check("E_IMPLEMENTATION_DUPLICATE");
    write("src/impl.ts", '/** @implements Action */\nexport class Action {run():void{}}\nclass HiddenExport {extra():void{}}\nexport {HiddenExport};');
    check("E_NOT_DESIGNED");
    pass(`single binding and export coverage TS${version}`, "mixin tags, duplicate implementations and local named export gaps block");
    const writer = contract("Writer", "write():void;", "callable Write is callable.");
    const copiedWriter = '/** @data\n * @description Copied writer API. */\nexport type Part=Record<"write",Writer["write"]>;';
    design(writer, copiedWriter, contract("Store extends Part", ""));
    write("src/impl.ts", '/** @implements Writer */\nexport class W {write():void{}}\n/** @implements Store */\nexport class S {write():void{}}');
    const writerTest = 'import assert from "node:assert/strict";import {test} from "node:test";import {W,S} from "./impl.ts";\n/** @tests Writer\n * @covers callable */\ntest("writer",()=>{assert.equal(typeof new W().write,"function")});\n';
    write("src/api.test.ts", writerTest);
    check("E_UNSUPPORTED_DECLARATION");
    design(writer, copiedWriter, contract("Store extends Writer, Part", ""));
    check("E_TEST_MISSING");
    write("src/api.test.ts", writerTest + '/** @tests Store\n * @covers callable */\ntest("store",()=>{assert.equal(typeof new S().write,"function")});\n');
    assert.equal(check(null).counts.linkedInvariants, 2);
    fs.rmSync(path.join(root, "src/api.test.ts"));
    pass(`inherited promises TS${version}`, "copied contract API cannot drop promises; explicit extends requires the derived test link");
    design(contract("Data", "get():{readonly size:number};"));
    write("src/impl.ts", 'type Row={readonly size:number};\n/** @implements Data */\nexport class Data {get():Row{return {size:1}}}');
    check(null);
    write("src/impl.ts", '/** @implements Data */\nexport class Data {get():{size:number}{return {size:1}}}');
    check("E_CONTRACT_SIGNATURE");
    design(contract("Value", "value:string;"));
    write("src/impl.ts", '/** @implements Value */\nexport class Value {get value():string{return ""}set value(x:number){}}');
    check("E_CONTRACT_SIGNATURE");
    pass(`nested types and setters TS${version}`, "equivalent alias passes; readonly and write-type drift block");
    design('/** @data\n * @description Recursive tree. */\nexport type Tree={next?:Tree};', contract("Reader", "read():Tree;"));
    write("src/impl.ts", 'interface Branch<T>{next?:Branch<T[]>}\n/** @implements Reader */\nexport class Reader {read():Branch<string>{return {}}}');
    check(null);
    design('/** @data\n * @description Recursive tree. */\nexport type Tree={value:string;next?:Tree};', contract("Reader", "read():Tree;"));
    write("src/impl.ts", 'interface Branch<T>{value:T extends string ? string : string;next?:Branch<T[]>}\n/** @implements Reader */\nexport class Reader {read():Branch<string>{return {value:""}}}');
    check("E_CONTRACT_UNCHECKABLE");
    pass(`recursive comparison TS${version}`, "equivalent argument-independent recursion passes; unresolved conditional recursion blocks explicitly");
    design('import type {ZodObject,ZodString} from "zod";', contract('Schema extends ZodObject<{id:ZodString},"strip">', ""));
    write("src/impl.ts", 'import {z} from "zod";\n/** @implements Schema */\nexport const schema=z.object({id:z.string()});');
    check(null);
    const schemaReview = cage(root, "review", "Schema", "--format", "json", "--files", "all");
    assert.equal(schemaReview.status, 0, schemaReview.stdout + schemaReview.stderr);
    assert.ok(schemaReview.stdout.includes("node_modules/zod/"), "review includes the package API declarations");
    write("src/impl.ts", 'import {z} from "zod";\n/** @implements Schema */\nexport const schema=Object.assign(z.object({id:z.string()}), {surplus:():void=>{}});');
    check("E_CONTRACT_EXTRA_MEMBER");
    write("src/impl.ts", 'import {z} from "zod";\n/** @implements Schema */\nexport const schema=z.object({id:z.number()});');
    check("E_TYPE_MISMATCH");
    pass(`package inheritance TS${version}`, "real Zod API inherits without copied methods; package declarations reach review; added API and changed field types block");
    // Alias identity comes from the installed package and the dependency declaration, not the import spelling.
    const manifestPath = path.join(root, "package.json");
    const packageManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    packageManifest.dependencies = { ...packageManifest.dependencies, "zod-alias": "npm:zod@3.25.76" };
    write("package.json", JSON.stringify(packageManifest));
    fs.cpSync(path.join(root, "node_modules/zod"), path.join(root, "node_modules/zod-alias"), { recursive: true });
    design('import type {ZodObject,ZodString} from "zod-alias";', contract('Schema extends ZodObject<{id:ZodString},"strip">', ""));
    write("src/impl.ts", 'import {z} from "zod-alias";\n/** @implements Schema */\nexport const schema=z.object({id:z.string()});');
    check(null);
    const aliasReview = cage(root, "review", "Schema", "--format", "json", "--files", "all");
    assert.equal(aliasReview.status, 0, aliasReview.stdout + aliasReview.stderr);
    assert.ok(aliasReview.stdout.includes("zod@3.25.76/"), "alias review identifies the real package");
    delete packageManifest.dependencies["zod-alias"];
    write("package.json", JSON.stringify(packageManifest));
    check("E_DESIGN_IMPORT");
    pass(`npm alias declarations TS${version}`, "real Zod alias imports and is review material; a mismatched package without an alias declaration blocks");

    // A workspace link is an installed package too; only its built declarations are part of the design.
    packageManifest.workspaces = ["packages/*"];
    write("package.json", JSON.stringify(packageManifest));
    fs.mkdirSync(path.join(root, "packages/shared/dist"), { recursive: true });
    fs.mkdirSync(path.join(root, "node_modules/@cage-e2e"), { recursive: true });
    write("packages/shared/package.json", JSON.stringify({ name: "@cage-e2e/shared", version: "1.0.0", types: "dist/index.d.ts" }));
    write("packages/shared/dist/index.d.ts", "export interface Receipt { id:string; }\n");
    fs.symlinkSync("../../packages/shared", path.join(root, "node_modules/@cage-e2e/shared"), "dir");
    design('import type {Receipt} from "@cage-e2e/shared";', contract("ReceiptMirror", "(receipt:Receipt):Receipt;"));
    write("src/impl.ts", 'import type {Receipt} from "@cage-e2e/shared";\n/** @implements ReceiptMirror */\nexport const mirror=(receipt:Receipt):Receipt=>receipt;');
    check(null);
    const workspaceReview = cage(root, "review", "ReceiptMirror", "--format", "json", "--files", "all");
    assert.equal(workspaceReview.status, 0, workspaceReview.stdout + workspaceReview.stderr);
    assert.ok(workspaceReview.stdout.includes("@cage-e2e/shared@1.0.0/dist/index.d.ts"), "workspace declaration is review material");
    write("src/impl.ts", 'import type {Receipt} from "@cage-e2e/shared";\n/** @implements ReceiptMirror */\nexport const mirror=(receipt:Receipt & {extra:number}):Receipt=>receipt;');
    check("E_TYPE_MISMATCH");
    write("packages/shared/src.ts", "export interface Receipt { id:string; }\n");
    write("packages/shared/package.json", JSON.stringify({ name: "@cage-e2e/shared", version: "1.0.0", types: "src.ts" }));
    check("E_DESIGN_IMPORT");
    pass(`workspace declarations TS${version}`, "installed link imports built types and supplies review material; signature drift and source-only exports block");

    fs.mkdirSync(path.join(root, "node_modules/declaration-probe"), { recursive: true });
    const declarationManifest = { name: "declaration-probe", version: "1.0.0", types: "index.d.ts" };
    write("node_modules/declaration-probe/package.json", JSON.stringify(declarationManifest));
    design('import type {Safe} from "declaration-probe";', contract("DeclarationPort", "read():Safe;"));
    write("src/impl.ts", 'import type {Safe} from "declaration-probe";\n/** @implements DeclarationPort */\nexport class Reader {read():Safe{throw new Error("fixture");}}');
    const originalOptions = fs.readFileSync(path.join(root, "tsconfig.json"), "utf8");
    const declarationOptions = JSON.parse(originalOptions);
    declarationOptions.compilerOptions.skipLibCheck = true;
    write("tsconfig.json", JSON.stringify(declarationOptions));
    for (const [text, expected] of [
      ['export type Safe = {id:string};\nexport type Unused = typeof import("optional-missing");\n', null],
      ['// @ts-ignore\nexport type Safe = typeof import("optional-missing");\n', null],
      ['export type Safe = {id:string}["missing"];\n', "E_DESIGN_IMPORT"],
      ['type Box<T> = {value:T};\nexport type Safe = Box;\n', "E_DESIGN_IMPORT"],
    ]) {
      write("node_modules/declaration-probe/index.d.ts", text);
      check(expected);
    }
    pass(`selected declaration diagnostics TS${version}`, "unrelated broken declarations and compiler-suppressed fallbacks pass; selected errors block even with skipLibCheck and identical imported types");

    // Both entry files already belong to the closure. Changing resolution alone must still break a final lock.
    write("node_modules/declaration-probe/index.d.ts", 'import type {} from "./other.js";\nexport interface Safe {id:string;}\n');
    write("node_modules/declaration-probe/other.d.ts", 'import type {} from "./index.js";\nexport interface Safe {id:number;}\n');
    design('import type {Safe} from "declaration-probe";', contract("DeclarationPort", "read():Safe;").replace("@contract", "@contract\n * @final"));
    check("E_LOCK_MISSING");
    assert.equal(cage(root, "lock").status, 0);
    write("node_modules/declaration-probe/package.json", JSON.stringify({ ...declarationManifest, types: "other.d.ts" }));
    check("E_LOCK_VIOLATION");
    write("node_modules/declaration-probe/package.json", JSON.stringify(declarationManifest));
    check(null);
    fs.rmSync(path.join(root, ".cage/lock.json"));
    write("tsconfig.json", originalOptions);
    pass(`package entry lock TS${version}`, "retargeting an entry with an unchanged declaration file set breaks the lock; restoring it passes");

    design('/** @data\n * @description Shared mutable interval. */\nexport type Band=[number,number];', contract("Hold", "hold(band:Band):void;"), contract("Beat", "beat(band:Band):void;"));
    write("src/impl.ts", 'type ActualBand=readonly [number,number];\n/** @implements Hold */\nexport class Hold {hold(band:ActualBand):void{}}\n/** @implements Beat */\nexport class Beat {beat(band:ActualBand):void{}}');
    const groupedRaw = check("E_CONTRACT_SIGNATURE");
    assert.equal(groupedRaw.diagnostics.filter(d => d.code === "E_CONTRACT_SIGNATURE").length, 2);
    const groupedText = cage(root, "check", "--max-diagnostics", "1");
    assert.equal(groupedText.status, 1);
    assert.equal(groupedText.stdout.split("\n").filter(line => line.startsWith("E_CONTRACT_SIGNATURE:")).length, 1);
    assert.ok(groupedText.stdout.includes("Hold.hold") && groupedText.stdout.includes("Beat.beat"), groupedText.stdout);
    assert.match(groupedText.stdout, /2 errors/);
    const groupedGate = cage(root, "gate", "--max-diagnostics", "1");
    assert.equal(groupedGate.status, 2);
    assert.equal(groupedGate.stderr.split("\n").filter(line => line.startsWith("E_CONTRACT_SIGNATURE:")).length, 1);
    assert.ok(groupedGate.stderr.includes("Hold.hold") && groupedGate.stderr.includes("Beat.beat"), groupedGate.stderr);
    assert.match(groupedGate.stderr, /2 other errors/);
    pass(`shared diagnostic cause TS${version}`, "one displayed cause retains both affected methods and both blockers; JSON keeps individual violations");
    design(contract("Worker", "run():void;"));
    write("src/impl.ts", 'class Base {static one():void{} static two():void{}}\n/** @implements Worker */\nexport class Worker extends Base {run():void{}}');
    check("E_CONTRACT_EXTRA_MEMBER");
    const missingStatic = cage(root, "check", "--max-diagnostics", "all");
    assert.equal(missingStatic.stdout.split("\n").filter(line => line.startsWith("E_CONTRACT_EXTRA_MEMBER:")).length, 2);
    assert.match(missingStatic.stdout, /absent from the static contracts/);
    pass(`undeclared static surface TS${version}`, "inherited statics without a static contract retain the full missing-surface explanation");
    log(`02-compiler-matrix-${version}`, `Project TypeScript ${version}; node:test and real Vitest 1.6.1 declarations; composition, nested types, setter inputs, recursion, check/gate and counts asserted.\n`);
  }

  // ---- 1: paths with $, backticks, quotes and apostrophes are data in both hooks.
  const SPECIAL = `we$HOME $(touch SUBST-RAN) \`touch TICK-RAN\` "dq" it's; a&b`;
  const repo = path.join(scratch, "special");
  fs.mkdirSync(repo);
  assert.equal(sh("git", ["init", "--quiet"], { cwd: repo }).status, 0);
  const special = path.join(repo, "apps", SPECIAL);
  // No design yet: the gate passes such a project, so a hook that runs is a hook that reached it.
  fs.mkdirSync(special, { recursive: true });
  fs.writeFileSync(path.join(special, "package.json"), JSON.stringify({ name: "special", private: true, type: "module" }));
  fs.cpSync(path.join(base, "node_modules"), path.join(special, "node_modules"), { recursive: true, verbatimSymlinks: true });
  const init = cage(special, "init", "--agent", "claude", "--agent", "codex", "--format", "json");
  assert.equal(init.status, 0, init.stderr);
  assert.deepEqual(json(init).diagnostics, []);
  const claudeCommand = JSON.parse(fs.readFileSync(path.join(repo, ".claude/settings.json"), "utf8")).hooks.Stop[0].hooks[0].command;
  const tomlLine = fs.readFileSync(path.join(repo, ".codex/config.toml"), "utf8").split("\n").find((line) => line.startsWith("command = "));
  const codexCommand = JSON.parse(tomlLine.slice("command = ".length));
  const claudeRun = sh("/bin/sh", ["-c", claudeCommand], { cwd: repo, env: { ...process.env, CLAUDE_PROJECT_DIR: repo }, input: "{}" });
  const codexRun = sh("/bin/sh", ["-c", codexCommand], { cwd: repo, input: "{}" });
  const markers = ["SUBST-RAN", "TICK-RAN"].filter((marker) => [scratch, repo, special].some((where) => fs.existsSync(path.join(where, marker))));
  const rerun = json(cage(special, "init", "--agent", "claude", "--agent", "codex", "--format", "json"));
  log("10-special-path-hooks", [`project dir: apps/${SPECIAL}`, `claude command: ${claudeCommand}`, `codex line: ${tomlLine}`, `claude hook exit ${claudeRun.status}: ${claudeRun.stderr}`, `codex hook exit ${codexRun.status}: ${codexRun.stderr}`, `markers found: ${JSON.stringify(markers)}`, `rerun: ${JSON.stringify(rerun.files)}`].join("\n"));
  assert.equal(claudeRun.status, 0, claudeRun.stderr);
  assert.equal(codexRun.status, 0, codexRun.stderr);
  assert.match(claudeRun.stderr, /^cage gate: no \*\.cage\.mdx design yet/);
  assert.deepEqual(markers, []);
  assert.ok(rerun.files.every((file) => file.status === "kept"), JSON.stringify(rerun.files));
  pass("1 special-character paths", "both hooks run the installed gate on the right project; no substitution ran; TOML string decodes; rerun keeps all");

  // ---- 1, as the CLI review reproduced it: `apps/$(touch injected-marker)` for Claude, `apps/o'hare` for Codex, run by sh and zsh.
  const exact = [];
  for (const [agent, PROJECT] of [["claude", "apps/$(touch injected-marker)"], ["codex", "apps/o'hare"]]) {
    const repo = path.join(scratch, `exact-${agent}`);
    fs.mkdirSync(path.join(repo, PROJECT), { recursive: true });
    assert.equal(sh("git", ["init", "--quiet"], { cwd: repo }).status, 0);
    fs.cpSync(path.join(base, "node_modules"), path.join(repo, "node_modules"), { recursive: true, verbatimSymlinks: true });
    // cage installed at the repository root, run from the project, as in the review.
    const run = sh(path.join(repo, "node_modules/.bin/cage"), ["init", "--agent", agent], { cwd: path.join(repo, PROJECT), input: "" });
    assert.equal(run.status, 0, `${run.stderr}${run.error ?? ""}`);
    const command =
      agent === "claude"
        ? JSON.parse(fs.readFileSync(path.join(repo, ".claude/settings.json"), "utf8")).hooks.Stop[0].hooks[0].command
        : JSON.parse(fs.readFileSync(path.join(repo, ".codex/config.toml"), "utf8").split("\n").find((line) => line.startsWith("command = ")).slice("command = ".length));
    for (const shell of ["/bin/sh", "/bin/zsh"].filter((candidate) => fs.existsSync(candidate))) {
      const hook = sh(shell, ["-c", command], { cwd: repo, env: { ...process.env, CLAUDE_PROJECT_DIR: repo }, input: '{"session_id":"e2e-quote","stop_hook_active":false}\n' });
      const marker = fs.existsSync(path.join(repo, "injected-marker")) || fs.existsSync(path.join(repo, "apps", "injected-marker"));
      exact.push(`${agent} ${shell}: ${command}\n  exit ${hook.status}; marker_created=${marker ? "yes" : "no"}; ${hook.stderr.trim()}`);
      assert.equal(hook.status, 0, hook.stderr);
      assert.match(hook.stderr, /^cage gate: no \*\.cage\.mdx design yet/);
      assert.equal(marker, false);
    }
    if (agent === "codex") exact.push(fs.readFileSync(path.join(repo, ".codex/config.toml"), "utf8"));
  }
  log("11-review-exact-hooks", exact.join("\n"));
  pass("1 review's exact paths", "apps/$(touch injected-marker) and apps/o'hare: the installed gate runs under sh and zsh, marker_created=no");

  // ---- 7: a hook that only mentions cage gate.
  const fake = project("fake-hook");
  fs.mkdirSync(path.join(fake, ".claude"));
  fs.writeFileSync(path.join(fake, ".claude/settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: 'echo cage gate --root "$CLAUDE_PROJECT_DIR/."' }] }] } }));
  const fakeInit = json(cage(fake, "init", "--agent", "claude", "--format", "json"));
  const commands = JSON.parse(fs.readFileSync(path.join(fake, ".claude/settings.json"), "utf8")).hooks.Stop.map((group) => group.hooks[0].command);
  log("20-fake-hook", `${JSON.stringify(fakeInit, null, 2)}\n${JSON.stringify(commands, null, 2)}`);
  assert.equal(commands.length, 2);
  assert.equal(commands[0], 'echo cage gate --root "$CLAUDE_PROJECT_DIR/."');
  assert.deepEqual(fakeInit.diagnostics.map(({ code }) => code), ["W_GATE_COMMAND"]);
  assert.equal(json(cage(fake, "init", "--agent", "claude", "--format", "json")).files.find((file) => file.path === ".claude/settings.json").status, "kept");
  pass("7 fake echo hook", "kept, the real gate added beside it, W_GATE_COMMAND; second run keeps");

  // ---- 8: a mention of cage check is not the rules.
  const rules = project("rules");
  fs.writeFileSync(path.join(rules, "CLAUDE.md"), "# Our project\n\nCI runs `cage check` on every push.\n");
  assert.equal(cage(rules, "init", "--agent", "claude").status, 0);
  const withRules = fs.readFileSync(path.join(rules, "CLAUDE.md"), "utf8");
  fs.writeFileSync(path.join(rules, "CLAUDE.md"), withRules.replace("## Contract harness", "## Our contract rules"));
  const edited = fs.readFileSync(path.join(rules, "CLAUDE.md"), "utf8");
  assert.equal(cage(rules, "init", "--agent", "claude").status, 0);
  log("30-rules-marker", fs.readFileSync(path.join(rules, "CLAUDE.md"), "utf8"));
  assert.ok(withRules.startsWith("# Our project\n\nCI runs `cage check` on every push.\n\n<!-- cage:rules -->\n## Contract harness\n"));
  assert.equal(fs.readFileSync(path.join(rules, "CLAUDE.md"), "utf8"), edited);
  pass("8 rules marker", "rules appended behind the marker; an edited section is kept on the next run");

  // ---- The review loop on the fixture: reviews required.
  const loop = project("review");
  assert.equal(cage(loop, "init", "--agent", "none").status, 0);
  const config = JSON.parse(fs.readFileSync(path.join(loop, ".cage/config.json"), "utf8"));
  fs.writeFileSync(path.join(loop, ".cage/config.json"), JSON.stringify({ ...config, review: "require" }, null, 2));
  const QUOTA = "src/modules/quota";
  const TESTS = `${QUOTA}/quota.test.ts`;
  const packet = (name = "Quota") => json(cage(loop, "review", name, "--format", "json"));
  const finding = (invariant, extra = {}) => ({ invariant, assessment: "adequate", reason: "E2E fixture verdict; not a real review.", evidence: `${TESTS}:9`, suggestedChange: null, ...extra });
  const recordQuota = (findings, fingerprint = packet().contracts[0].fingerprint) => {
    fs.writeFileSync(path.join(loop, "verdicts.json"), JSON.stringify({ version: 1, verdicts: [{ contract: "Quota", fingerprint, findings }] }));
    return cage(loop, "review", "--record", "verdicts.json");
  };
  const quotaFindings = () => packet().contracts[0].invariants.map(({ id }) => finding(id));
  const reviewFile = path.join(loop, ".cage/review.json");

  // ---- 5: incomplete verdicts are refused, the review file unchanged.
  assert.equal(recordQuota(quotaFindings()).status, 0);
  const recorded = fs.readFileSync(reviewFile);
  const refusals = [];
  for (const [name, change] of [
    ["blank reason", (findings) => [{ ...findings[0], reason: "  " }, ...findings.slice(1)]],
    ["null evidence on adequate", (findings) => [{ ...findings[0], evidence: null }, ...findings.slice(1)]],
    ["blank evidence on insufficient-context", (findings) => [{ ...findings[0], assessment: "insufficient-context", evidence: "" }, ...findings.slice(1)]],
    ["contract-level note without evidence", (findings) => [...findings, finding(null, { evidence: null })]],
  ]) {
    const run = recordQuota(change(quotaFindings()));
    refusals.push(`${name}: exit ${run.status}\n${run.stdout}`);
    assert.equal(run.status, 1, run.stdout);
    assert.match(run.stdout, /E_REVIEW_VERDICT/);
    assert.deepEqual(fs.readFileSync(reviewFile), recorded);
  }
  // As the source review sent it: every contract, reason "" and evidence null. The index names every contract with its invariants.
  const all = json(cage(loop, "review", "--all", "--format", "json")).contracts;
  fs.writeFileSync(
    path.join(loop, "empty.json"),
    JSON.stringify({ version: 1, verdicts: all.map(({ contract, fingerprint, invariants }) => ({ contract, fingerprint, findings: (invariants.length > 0 ? invariants : [null]).map((id) => ({ invariant: id, assessment: "adequate", reason: "", evidence: null, suggestedChange: null })) })) }),
  );
  const empty = cage(loop, "review", "--record", "empty.json");
  refusals.push(`all contracts with reason "" and evidence null: exit ${empty.status}\n${empty.stdout}`);
  assert.equal(empty.status, 1);
  assert.equal((empty.stdout.match(/E_REVIEW_VERDICT/g) ?? []).length, 2 * all.length);
  assert.deepEqual(fs.readFileSync(reviewFile), recorded);
  assert.equal(recordQuota([{ ...quotaFindings()[0], assessment: "insufficient-context", evidence: null }, ...quotaFindings().slice(1)]).status, 0);
  log("40-verdict-rules", refusals.join("\n"));
  pass("5 complete verdicts", "blank reason, null/blank evidence and an evidence-less contract note refused; review.json byte-identical; insufficient-context with null accepted");

  // File pragmas outside a selected declaration must stale its review and be visible to reviewers.
  const pragmaFile = path.join(loop, QUOTA, "memory-quota.ts");
  const withoutPragma = fs.readFileSync(pragmaFile, "utf8");
  const unused = "const unrelatedHeader = 1;\n";
  fs.writeFileSync(pragmaFile, unused + withoutPragma);
  assert.equal(recordQuota(quotaFindings()).status, 0);
  fs.writeFileSync(pragmaFile, `// Explanation.\n${unused}${withoutPragma}`);
  assert.equal(packet().contracts[0].recordedReview.status, "current");
  fs.writeFileSync(pragmaFile, `// @ts-nocheck\n${unused}${withoutPragma}`);
  const pragmaPacket = packet();
  assert.equal(pragmaPacket.contracts[0].recordedReview.status, "outdated");
  const pragmaExcerpt = pragmaPacket.excerpts.find(({ file }) => file === `${QUOTA}/memory-quota.ts`);
  assert.ok(pragmaExcerpt.pieces.some(({ startLine, text }) => startLine === 1 && text.includes("// @ts-nocheck")));
  assert.match(cage(loop, "review", "Quota").stdout, /\/\/ @ts-nocheck/);
  assert.equal(recordQuota(quotaFindings()).status, 0);
  fs.writeFileSync(pragmaFile, `${unused}// @ts-nocheck\n${withoutPragma}`);
  assert.equal(packet().contracts[0].recordedReview.status, "outdated");
  log("41-file-pragmas", JSON.stringify(pragmaPacket, null, 2));
  fs.writeFileSync(pragmaFile, withoutPragma);
  assert.equal(recordQuota(quotaFindings()).status, 0);
  pass("file pragma freshness and excerpts", "ordinary prose stays current; adding or moving @ts-nocheck invalidates; default JSON and Markdown include the directive");

  // Shared dependency edits produce a runnable group in the installed CLI, then one batch of separate verdicts.
  const groupedRoot = project("shared-review");
  fs.mkdirSync(path.join(groupedRoot, "test-support"));
  const sharedPath = "test-support/shared.ts";
  fs.writeFileSync(path.join(groupedRoot, sharedPath), "export const shared = 1;\n");
  for (const file of [TESTS, "src/modules/campaigns/send.test.ts"]) {
    const target = path.join(groupedRoot, file);
    fs.writeFileSync(target, 'import { shared } from "../../../test-support/shared.ts";\nvoid shared;\n' + fs.readFileSync(target, "utf8"));
  }
  assert.equal(cage(groupedRoot, "review", "--accept").status, 0);
  fs.writeFileSync(path.join(groupedRoot, sharedPath), "export const shared = 2;\n");
  const sendPath = path.join(groupedRoot, "src/modules/campaigns/send-service.ts");
  fs.writeFileSync(sendPath, fs.readFileSync(sendPath, "utf8").replace('return "sent";', 'return "limited";'));
  const groupedIndex = json(cage(groupedRoot, "review", "--format", "json"));
  assert.equal(groupedIndex.groups.length, 1);
  const [suggestion] = groupedIndex.groups;
  assert.deepEqual(suggestion.command, ["cage", "review", "Quota", "Send"]);
  assert.ok(suggestion.sharedChanges.some(({ change }) => change.file === sharedPath));
  assert.ok(suggestion.additionalChanges.some(({ contract, changed }) => contract === "Send" && changed.some(({ kind }) => kind === "implementation")));
  const groupedRun = cage(groupedRoot, ...suggestion.command.slice(1), "--format", "json");
  assert.equal(groupedRun.status, 0, groupedRun.stdout);
  const groupedPacket = json(groupedRun);
  const groupedMarkdown = cage(groupedRoot, ...suggestion.command.slice(1)).stdout;
  assert.equal(groupedMarkdown.split("export const shared = 2;").length - 1, 1);
  assert.ok(groupedMarkdown.indexOf("export const shared = 2;") < groupedMarkdown.indexOf("# Send ("));
  log("42-review-groups-index", cage(groupedRoot, "review").stdout);
  log("43-review-groups-packet", groupedMarkdown);
  const contextRun = cage(groupedRoot, ...suggestion.command.slice(1), "--files", "context", "--format", "json");
  assert.equal(contextRun.status, 0, contextRun.stdout);
  const contextPacket = json(contextRun);
  assert.equal(contextPacket.complete, true);
  assert.deepEqual(contextPacket.contracts.map(({ fingerprint }) => fingerprint), groupedPacket.contracts.map(({ fingerprint }) => fingerprint));
  const contextMarkdown = cage(groupedRoot, ...suggestion.command.slice(1), "--files", "context").stdout;
  assert.equal(contextMarkdown.split("export const shared = 2;").length - 1, 1);
  assert.match(contextMarkdown, /tests: all 4 active; not run by cage/);
  assert.ok(contextPacket.files.some(({ path }) => path === "src/modules/campaigns/campaigns.cage.mdx"));
  assert.ok(contextPacket.files.some(({ path }) => path === "src/modules/mail/callback-sender.ts"));
  assert.ok(contextMarkdown.includes("await assert.rejects"));
  log("44-review-context-packet", contextMarkdown);
  // A consumer can resolve compact references and construct the existing record format with full evidence paths.
  const displayedFiles = new Map([...groupedMarkdown.matchAll(/^(F\d+) (".*")$/gm)].map((match) => [match[1], JSON.parse(match[2])]));
  const displayedTests = [...groupedMarkdown.matchAll(/^T\d+ (F\d+):(\d+):(\d+) (".*")$/gm)].map((match) => ({ file: displayedFiles.get(match[1]), line: Number(match[2]), column: Number(match[3]), title: JSON.parse(match[4]) }));
  const displayedFingerprints = new Map([...groupedMarkdown.matchAll(/^(\w+): (sha256:code-v2:[a-f0-9]+)$/gm)].map((match) => [match[1], match[2]]));
  fs.writeFileSync(path.join(groupedRoot, "group-verdicts.json"), JSON.stringify({ version: 1, verdicts: groupedPacket.contracts.map(({ contract, fingerprint, invariants }) => {
    assert.equal(displayedFingerprints.get(contract), fingerprint);
    return { contract, fingerprint: displayedFingerprints.get(contract), findings: invariants.map(({ id, tests }) => {
      const evidence = displayedTests.find((test) => test.file === tests[0].file && test.line === tests[0].line && test.column === tests[0].column && test.title === tests[0].title);
      assert.ok(evidence, `Missing displayed test for ${contract}.${id}`);
      return finding(id, { evidence: `${evidence.file}:${evidence.line}` });
    }) };
  }) }));
  assert.equal(cage(groupedRoot, "review", "--record", "group-verdicts.json").status, 0);
  assert.deepEqual(json(cage(groupedRoot, "review", "--format", "json")).groups, []);
  pass("shared review groups", "installed CLI suggests one command, prints shared code first once, retains extra edits, records separate verdicts together");
  pass("context review prototype", "installed CLI retains requirements, unchanged tests and helpers; shared code appears once and fingerprints match the default");

  const membersRoot = project("member-review");
  fs.mkdirSync(path.join(membersRoot, "test-support"));
  const memberFile = path.join(membersRoot, sharedPath);
  const memberSource = "export const shared = { quota: 1, send: 2 };\n";
  fs.writeFileSync(memberFile, memberSource);
  for (const [file, field] of [[TESTS, "quota"], ["src/modules/campaigns/send.test.ts", "send"]]) {
    const target = path.join(membersRoot, file);
    fs.writeFileSync(target, `import { shared } from "../../../test-support/shared.ts";\nvoid shared.${field};\n` + fs.readFileSync(target, "utf8"));
  }
  assert.equal(cage(membersRoot, "review", "--accept", "--all").status, 0);
  fs.writeFileSync(memberFile, memberSource.replace("quota: 1", "unused: 99, quota: 1"));
  assert.deepEqual(json(cage(membersRoot, "review", "--format", "json")).contracts, []);
  fs.writeFileSync(memberFile, memberSource.replace("quota: 1", "quota: 3"));
  const memberIndex = json(cage(membersRoot, "review", "--format", "json"));
  assert.deepEqual(memberIndex.contracts.map(c => c.contract), ["Quota"]);
  const memberPacket = cage(membersRoot, "review", "Quota");
  assert.equal(memberPacket.status, 0);
  assert.match(memberPacket.stdout, /quota: 3/);
  log("45-review-members", memberPacket.stdout);
  pass("dependency object members", "unused field keeps both reviews current; quota field invalidates only Quota; packet shows the changed declaration");

  // ---- 2: a link out of the project, with preserveSymlinks: the sentinel is never read.
  const outside = path.join(scratch, "outside");
  fs.mkdirSync(outside);
  const SENTINEL = "SENTINEL-OUTSIDE-7731";
  fs.writeFileSync(path.join(outside, "secret.ts"), `export const SECRET = "${SENTINEL}";\n`);
  const testText = fs.readFileSync(path.join(loop, TESTS), "utf8");
  // As the source review reproduced it: `leak.ts` links out, the test imports it, the tsconfig is the fixture's own.
  fs.symlinkSync(path.join(outside, "secret.ts"), path.join(loop, QUOTA, "leak.ts"));
  fs.writeFileSync(path.join(loop, TESTS), testText.replace('import { MemoryQuota } from "./memory-quota.ts";', 'import { MemoryQuota } from "./memory-quota.ts";\nimport { SECRET } from "./leak.ts";\nvoid SECRET;'));
  const leakJson = cage(loop, "review", "Quota", "--format", "json");
  const leak = json(leakJson).contracts[0];
  log("49-outside-link-review-case", `exit ${leakJson.status}\nsentinel in packet: ${leakJson.stdout.includes(SENTINEL)}\nhelpers ${JSON.stringify(leak.helpers)}\nfingerprinted ${JSON.stringify(leak.fingerprinted)}\n${JSON.stringify(leak.diagnostics.filter(({ code }) => code.includes("OUTSIDE") || code.includes("SCOPE")), null, 2)}`);
  assert.ok(!leakJson.stdout.includes(SENTINEL) && !cage(loop, "review", "Quota").stdout.includes(SENTINEL));
  assert.ok(!leak.helpers.includes(`${QUOTA}/leak.ts`) && !leak.fingerprinted.includes(`${QUOTA}/leak.ts`));
  assert.ok(leak.diagnostics.some(({ code, file }) => code === "W_OUTSIDE_ROOT" && file === `${QUOTA}/leak.ts`));
  fs.rmSync(path.join(loop, QUOTA, "leak.ts"));

  fs.symlinkSync(path.join(outside, "secret.ts"), path.join(loop, QUOTA, "linked.ts"));
  fs.writeFileSync(path.join(loop, TESTS), testText.replace('import { MemoryQuota } from "./memory-quota.ts";', 'import { MemoryQuota } from "./memory-quota.ts";\nimport { SECRET } from "./linked.ts";\nvoid SECRET;'));
  const implementation = path.join(loop, QUOTA, "memory-quota.ts");
  const implementationText = fs.readFileSync(implementation, "utf8");
  fs.writeFileSync(implementation, `import { SECRET } from "./linked.ts";\nvoid SECRET;\n${implementationText}`);
  const tsconfig = JSON.parse(fs.readFileSync(path.join(loop, "tsconfig.json"), "utf8"));
  fs.writeFileSync(path.join(loop, "tsconfig.json"), JSON.stringify({ ...tsconfig, compilerOptions: { ...tsconfig.compilerOptions, preserveSymlinks: true } }));
  const linkedJson = cage(loop, "review", "Quota", "--format", "json");
  const linkedMarkdown = cage(loop, "review", "Quota");
  const linked = json(linkedJson).contracts[0];
  assert.equal(recordQuota(quotaFindings(), linked.fingerprint).status, 0);
  const outputs = [linkedJson.stdout, linkedJson.stderr, linkedMarkdown.stdout, linkedMarkdown.stderr, fs.readFileSync(reviewFile, "utf8"), cage(loop, "check", "--format", "json").stdout];
  fs.chmodSync(path.join(outside, "secret.ts"), 0o000);
  const unopened = json(cage(loop, "review", "Quota", "--format", "json")).contracts[0];
  fs.chmodSync(path.join(outside, "secret.ts"), 0o644);
  log("50-outside-link", [`diagnostics: ${JSON.stringify(linked.diagnostics, null, 2)}`, `helpers: ${JSON.stringify(linked.helpers)}`, `fingerprinted: ${JSON.stringify(linked.fingerprinted)}`, `sentinel in any output: ${outputs.some((text) => text.includes(SENTINEL))}`, `with the outside file unreadable: ${JSON.stringify(unopened.diagnostics.map(({ code }) => code))}`].join("\n"));
  assert.ok(!outputs.some((text) => text.includes(SENTINEL)));
  assert.ok(linked.diagnostics.some(({ code }) => code === "W_OUTSIDE_ROOT"));
  // Neither the packet nor check reports configured fingerprint bounds.
  assert.ok(!linked.diagnostics.some(({ code }) => code.endsWith("REVIEW_SCOPE_LIMIT")));
  // Reviews are required here; the boundary is still not a scope error.
  assert.ok(!json(cage(loop, "check", "--format", "json")).diagnostics.some(({ code }) => code.endsWith("REVIEW_SCOPE_LIMIT")));
  assert.ok(!unopened.diagnostics.some(({ code }) => code === "E_ENVIRONMENT"));
  fs.writeFileSync(path.join(loop, TESTS), testText);
  fs.writeFileSync(implementation, implementationText);
  fs.writeFileSync(path.join(loop, "tsconfig.json"), JSON.stringify(tsconfig));
  fs.rmSync(path.join(loop, QUOTA, "linked.ts"));
  pass("2 link out of the project", "review's leak.ts case and a preserveSymlinks case: sentinel absent from packet JSON/Markdown, review.json and check; W_OUTSIDE_ROOT, no scope-limit diagnostics; unreadable target never opened");

  // ---- 3: setup in a block and a loop around a test.
  fs.writeFileSync(
    path.join(loop, TESTS),
    [
      'import assert from "node:assert/strict";',
      'import { describe, it } from "node:test";',
      'import { MemoryQuota } from "./memory-quota.ts";',
      "",
      "/** @tests Quota */",
      'describe("MemoryQuota", () => {',
      "  for (const left of [0]) {",
      '    const unknown = "nobody";',
      "    /** @covers empty */",
      '    it("refuses", async () => {',
      "      const quota = new MemoryQuota({ a: left });",
      '      assert.equal(await quota.take("a"), false);',
      "      assert.equal(await quota.take(unknown), false);",
      "    });",
      "  }",
      "  {",
      "    const start = 1;",
      "    const expected = false;",
      "    /** @covers consume accounts race */",
      '    it("takes one", async () => {',
      "      const quota = new MemoryQuota({ a: start, b: 1 });",
      '      assert.equal(await quota.take("a"), true);',
      '      assert.equal(await quota.take("a"), expected);',
      "    });",
      "  }",
      "});",
      "",
    ].join("\n"),
  );
  assert.equal(recordQuota(quotaFindings()).status, 0);
  const stale = [];
  for (const [from, to, title] of [
    ["for (const left of [0])", "for (const left of [1])", "refuses"],
    ["const start = 1;", "const start = 2;", "takes one"],
    // The source review's case: the expected value of an assertion, inverted in the block around the test.
    ["const expected = false;", "const expected = true;", "takes one"],
  ]) {
    const before = packet().contracts[0].fingerprint;
    fs.writeFileSync(path.join(loop, TESTS), fs.readFileSync(path.join(loop, TESTS), "utf8").replace(from, to));
    const check = cage(loop, "check");
    const after = packet().contracts[0].fingerprint;
    stale.push(`${from} -> ${to}: fingerprint ${before} -> ${after}\n${check.stdout.split("\n").filter((line) => line.includes("REVIEW_STALE")).join("\n")}`);
    assert.notEqual(after, before);
    assert.equal(check.status, 1);
    // The code heads the diagnostic; the changed parts follow one a line.
    assert.match(check.stdout, new RegExp(`E_REVIEW_STALE: Quota \\([^\\n]+\\)\\n(?:[^\\n]*\\n)*?  - test "${title}"`));
    assert.equal(recordQuota(quotaFindings()).status, 0);
  }
  log("60-block-loop-setup", stale.join("\n"));
  fs.writeFileSync(path.join(loop, TESTS), testText);
  assert.equal(recordQuota(quotaFindings()).status, 0);
  pass("3 block and loop setup", "a loop header and a block variable each make their test's review outdated");

  // ---- 4: a dependency the review cannot read.
  // As the source review reproduced it: the test imports a readable test-support/a.ts, which imports test-support/b.ts.
  fs.mkdirSync(path.join(loop, "test-support"));
  fs.writeFileSync(path.join(loop, "test-support/a.ts"), 'import { seed } from "./b.ts";\nexport const initial = () => ({ a: seed });\n');
  fs.writeFileSync(path.join(loop, "test-support/b.ts"), "export const seed = 1;\n");
  fs.writeFileSync(path.join(loop, TESTS), testText.replace('import { MemoryQuota } from "./memory-quota.ts";', 'import { MemoryQuota } from "./memory-quota.ts";\nimport { initial } from "../../../test-support/a.ts";\nvoid initial;'));
  assert.equal(recordQuota(quotaFindings()).status, 0);
  const beforeUnreadable = fs.readFileSync(reviewFile);
  fs.chmodSync(path.join(loop, "test-support/b.ts"), 0o000);
  const holed = cage(loop, "review", "Quota", "--format", "json");
  const refused = recordQuota(quotaFindings(), json(holed).contracts[0].fingerprint);
  fs.chmodSync(path.join(loop, "test-support/b.ts"), 0o644);
  log("70-unreadable-dependency", `review exit ${holed.status}, ok ${json(holed).ok}, complete ${json(holed).complete}\n${JSON.stringify(json(holed).contracts[0].diagnostics.filter(({ code }) => code === "E_ENVIRONMENT"), null, 2)}\nrecord exit ${refused.status}\n${refused.stdout}`);
  assert.equal(holed.status, 2);
  assert.equal(json(holed).complete, false);
  assert.ok(json(holed).contracts[0].diagnostics.some(({ code, file }) => code === "E_ENVIRONMENT" && file === "test-support/b.ts"));
  assert.equal(refused.status, 2);
  assert.deepEqual(fs.readFileSync(reviewFile), beforeUnreadable);
  fs.writeFileSync(path.join(loop, TESTS), testText);
  fs.writeFileSync(path.join(loop, "tsconfig.json"), JSON.stringify(tsconfig));
  pass("4 unreadable dependency", "packet E_ENVIRONMENT, complete false, exit 2; record exit 2; review.json byte-identical");

  // ---- 6: a value import of a type, under node:test.
  fs.writeFileSync(path.join(loop, QUOTA, "shapes.ts"), "export interface Shape { size: number }\nexport class Klass {}\nexport type { Klass as OnlyType };\n");
  const typeCases = [];
  fs.writeFileSync(path.join(loop, QUOTA, "type-only.ts"), "export type MissingRuntime = { size: number };\n");
  fs.writeFileSync(path.join(loop, QUOTA, "typestar.ts"), 'export type * from "./shapes.ts";\n');
  for (const [imports, expected] of [
    // The source review's case.
    ['import { MissingRuntime } from "./type-only.ts";', "broken"],
    ['import { Shape } from "./shapes.ts";', "broken"],
    ['import { OnlyType } from "./shapes.ts";', "broken"],
    ['import { Klass } from "./typestar.ts";', "broken"],
    ['import type { Shape } from "./shapes.ts";', "active"],
    ['import { type Shape, Klass } from "./shapes.ts";', "active"],
  ]) {
    fs.writeFileSync(path.join(loop, TESTS), testText.replace('import { MemoryQuota } from "./memory-quota.ts";', `import { MemoryQuota } from "./memory-quota.ts";\n${imports}`));
    const check = json(cage(loop, "check", "--format", "json"));
    const inactive = check.diagnostics.filter(({ code }) => code === "E_TEST_INACTIVE");
    typeCases.push(`${imports} -> activeTestDeclarations ${check.counts.activeTestDeclarations}; ${inactive[0]?.message ?? "no E_TEST_INACTIVE"}`);
    if (expected === "broken") assert.ok(inactive.length > 0 && /only as a type/.test(inactive[0].message), imports);
    else assert.equal(inactive.length, 0, imports);
  }
  fs.writeFileSync(path.join(loop, TESTS), testText);
  log("80-type-only-imports", typeCases.join("\n"));
  pass("6 value import of a type", "interface and `export type` re-export broken under node:test; `import type` and `{ type X }` active");

  // ---- 6, as the source acceptance reproduced it: Vitest, default options, a named alias re-export of an interface used as a value.
  const vitest = project("vitest-alias");
  fs.mkdirSync(path.join(vitest, "node_modules/vitest"), { recursive: true });
  fs.writeFileSync(path.join(vitest, "node_modules/vitest/package.json"), JSON.stringify({ name: "vitest", version: "4.0.0", type: "module", exports: { ".": { types: "./index.d.ts" } } }));
  fs.writeFileSync(path.join(vitest, "node_modules/vitest/index.d.ts"), "type Declare = (title: unknown, ...rest: unknown[]) => void;\nexport declare const describe: Declare;\nexport declare const it: Declare;\n");
  assert.equal(cage(vitest, "init", "--agent", "none", "--test-adapter", "vitest").status, 0);
  fs.writeFileSync(path.join(vitest, QUOTA, "defs.ts"), "export interface Shape { n: number }\nexport class Klass { n = 1 }\n");
  fs.writeFileSync(path.join(vitest, QUOTA, "alias.ts"), 'export { Shape as Alias, Klass as Real } from "./defs.ts";\n');
  const vitestTest = (imports, body) =>
    [imports, 'import { describe, it } from "vitest";', 'import { MemoryQuota } from "./memory-quota.ts";', "", "/** @tests Quota */", 'describe("q", () => {', "  /** @covers accounts empty consume race */", `  it("x", () => { void MemoryQuota; ${body} });`, "});", ""].join("\n");
  const aliasCases = [];
  for (const [imports, body, expected] of [
    ['import { Alias } from "./alias.ts";', "void Alias;", "broken"],
    ['import { Alias } from "./alias.ts";', "const s: Alias = { n: 1 }; void s;", "active"],
    ['import { Alias } from "./alias.ts";', "const Alias = 1; void Alias;", "active"],
    ['import { Real } from "./alias.ts";', "void new Real();", "active"],
  ]) {
    fs.writeFileSync(path.join(vitest, QUOTA, "quota.test.ts"), vitestTest(imports, body));
    const check = json(cage(vitest, "check", "--format", "json"));
    const inactive = check.diagnostics.filter(({ code }) => code === "E_TEST_INACTIVE");
    aliasCases.push(`${imports} ${body} -> activeTestDeclarations ${check.counts.activeTestDeclarations}; ${inactive[0]?.message ?? "no E_TEST_INACTIVE"}`);
    if (expected === "broken") assert.ok(inactive.length > 0 && /"Alias" only as a type/.test(inactive[0].message), `${imports} ${body}`);
    else assert.equal(inactive.length, 0, `${imports} ${body}`);
  }
  log("81-vitest-alias", aliasCases.join("\n"));
  pass("6 Vitest alias re-export", "value use of `export { Shape as Alias }` is broken-import; a type use, a shadowing const and a real class alias stay active");

  // ---- 9: the formats of review, in the shipped README and in the CLI.
  const readme = fs.readFileSync(path.join(base, "node_modules/cage-ts/README.md"), "utf8");
  const wrong = cage(loop, "review", "--format", "text");
  const wrongRecord = cage(loop, "review", "--record", "verdicts.json", "--format", "markdown");
  log("90-formats", `${wrong.stderr}\n${wrongRecord.stderr}`);
  assert.match(readme, /the `review` packet `markdown`/);
  assert.match(wrong.stderr, /expected markdown or json/);
  assert.match(wrongRecord.stderr, /expected text or json/);
  pass("9 review formats", "shipped README names markdown for the packet; the CLI names markdown|json and text|json");

  // ---- 10: drafts through the installed CLI: create, candidate check, conflict, refusal, activation, isolation.
  const drafts = project("drafts");
  const QUOTA_DESIGN = "src/modules/quota/quota.cage.mdx";
  const QUOTA_DRAFT = "src/modules/quota/quota.cage.draft.mdx";
  const readText = (file) => fs.readFileSync(path.join(drafts, file), "utf8");
  const writeText = (file, text) => fs.writeFileSync(path.join(drafts, file), text);
  const draftRuns = [];
  const draftRun = (...args) => {
    const run = cage(drafts, "draft", ...args);
    draftRuns.push(`$ cage draft ${args.join(" ")}\nexit ${run.status}\n${run.stdout}${run.stderr}`);
    return run;
  };
  const activeDesign = readText(QUOTA_DESIGN);
  const checkBefore = cage(drafts, "check", "--format", "json").stdout;
  assert.equal(draftRun("create", QUOTA_DESIGN).status, 0);
  assert.ok(readText(QUOTA_DRAFT).startsWith(`{/* cage draft v1\ntarget: ${QUOTA_DESIGN}\nbase: sha256:`));
  const draftText = readText(QUOTA_DRAFT);
  // A consumer (campaigns) loses its type: the candidate fails there, activation writes nothing.
  writeText(QUOTA_DRAFT, draftText.replace("export type AccountId = string;", "export type AccountKey = string;").replace("take(accountId: AccountId)", "take(accountId: AccountKey)"));
  const brokenCandidate = draftRun("check", QUOTA_DRAFT, "--format", "json");
  assert.equal(brokenCandidate.status, 1);
  assert.ok(json(brokenCandidate).diagnostics.some(({ code, file }) => code === "E_TYPESCRIPT" && file === "src/modules/campaigns/campaigns.cage.mdx"), brokenCandidate.stdout);
  assert.deepEqual(json(brokenCandidate).validation.implementations, "not-checked");
  const refusedDraft = readText(QUOTA_DRAFT);
  assert.equal(draftRun("activate", QUOTA_DRAFT).status, 1);
  assert.equal(readText(QUOTA_DESIGN), activeDesign);
  assert.equal(readText(QUOTA_DRAFT), refusedDraft);
  // Neither the invalid draft nor a draft that is not MDX at all changes what check reports.
  assert.equal(cage(drafts, "check", "--format", "json").stdout, checkBefore);
  writeText(QUOTA_DRAFT, "{/* cage draft v1\n<Unclosed\n");
  assert.equal(cage(drafts, "check", "--format", "json").stdout, checkBefore);
  assert.equal(draftRun("check", QUOTA_DRAFT).status, 1);
  // The design changed after the draft was made: a conflict until it is the base text again.
  const proposed = draftText.replace("Квота визначає", "Квота (v2) визначає");
  writeText(QUOTA_DRAFT, proposed);
  writeText(QUOTA_DESIGN, `${activeDesign}\nA later rule.\n`);
  const conflict = draftRun("activate", QUOTA_DRAFT, "--format", "json");
  assert.equal(conflict.status, 1);
  assert.deepEqual(json(conflict).diagnostics.filter(({ severity }) => severity === "error").map(({ code }) => code), ["E_DRAFT_CONFLICT"]);
  assert.equal(readText(QUOTA_DRAFT), proposed);
  writeText(QUOTA_DESIGN, activeDesign);
  const activatedRun = draftRun("activate", QUOTA_DRAFT);
  assert.equal(activatedRun.status, 0);
  assert.match(activatedRun.stdout, /^ {2}next: +cage check$/m);
  assert.equal(readText(QUOTA_DESIGN), proposed.slice(proposed.indexOf("*/}\n") + "*/}\n".length));
  assert.equal(fs.existsSync(path.join(drafts, QUOTA_DRAFT)), false);
  assert.equal(cage(drafts, "check", "--phase", "design").status, 0);
  // Paths count from the root and stay in it.
  const escaping = draftRun("create", "../outside/x.cage.mdx");
  assert.equal(escaping.status, 2);
  assert.match(escaping.stderr, /leaves its directory/);
  log("95-drafts", draftRuns.join("\n"));
  pass("10 drafts", "create, consumer-breaking candidate refused byte-identical, drafts invisible to check, live base conflict, activation, path escape refused");

  console.log(`\ne2e: ${passed.length} scenarios passed; evidence in ${path.relative(repository, evidence)}`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
