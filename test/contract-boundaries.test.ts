import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { CheckReport } from "../src/check.ts";
import type { ReviewReport } from "../src/review.ts";
import { cli, contract, designProject, editFile, mdx, PROJECT_OPTIONS, writeFile } from "./helpers.ts";

const compilers = ["typescript-5", "typescript"];
function project(t: TestContext, compiler: string, design: string, files: Record<string, string>) {
  const root = designProject(t, { m: design }, {
    ".cage/config.json": JSON.stringify({ version: 1, coverage: "require", review: "off" }),
    "tsconfig.json": JSON.stringify({ compilerOptions: { ...PROJECT_OPTIONS, types: ["node"], skipLibCheck: true } }),
    ...files,
  });
  fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
  fs.symlinkSync(path.resolve("node_modules", compiler), path.join(root, "node_modules/typescript"), "dir");
  return root;
}
function check(root: string, expected?: string) {
  const run = cli(root, "check", "--format", "json", "--max-diagnostics", "all");
  const report = JSON.parse(run.stdout) as CheckReport;
  const errors = report.diagnostics.filter(d => d.severity === "error");
  if (expected) assert.ok(errors.some(d => d.code === expected), run.stdout);
  else assert.deepEqual(errors, [], run.stdout);
  assert.equal(cli(root, "gate").code, expected ? 2 : 0, run.stdout);
  return report;
}
const family = contract("Rules", "", "@invariant identity returns the input unchanged").replace("@contract", "@family");

/** @tests Cli
 * @covers contract-families contract-inheritance exact-signatures gate */
test("memberless families share promises across different arities without inheriting extra call signatures on TS5/6", t => {
  for (const compiler of compilers) {
    const root = project(t, compiler, mdx(family, contract("First extends Rules", "(input:string):string;"), contract("Second extends Rules", "(input:string,label:string):string;")), {
      "src/m/impl.ts": '/** @implements First */\nexport function first(input:string):string{return input}\n/** @implements Second */\nexport function second(input:string,label:string):string{return input}',
      "src/m/impl.test.ts": 'import {test} from "node:test";import assert from "node:assert/strict";import {first,second} from "./impl.ts";\n/** @tests First\n * @covers identity */\ntest("first",()=>assert.equal(first("a"),"a"));\n/** @tests Second\n * @covers identity */\ntest("second",()=>assert.equal(second("a","b"),"a"));',
    });
    assert.equal(check(root).counts.linkedInvariants, 2);
    editFile(root, "src/m/impl.ts", s => s.replace('label:string', 'label?:string'));
    check(root, "E_CONTRACT_SIGNATURE");
    editFile(root, "src/m/impl.ts", s => s.replace('label?:string', 'label:string'));
    editFile(root, "src/m/impl.test.ts", s => s.slice(0, s.indexOf('/** @tests Second')));
    check(root, "E_TEST_MISSING");
    writeFile(root, "src/m/m.cage.mdx", mdx(contract("Empty", "")));
    check(root, "E_UNSUPPORTED_DECLARATION");
  }
});

/** @tests Cli
 * @covers exact-surface exact-signatures gate */
test("abstract bases bind their full API and test subclasses supply evidence without blessing every descendant on TS5/6", t => {
  for (const compiler of compilers) {
    const root = project(t, compiler, mdx(contract("Lifecycle", "run():string;", "@invariant value returns the hook value")), {
      "src/m/impl.ts": '/** @implements Lifecycle */\nexport abstract class Base<T=string> {protected abstract value():T;run():string{return String(this.value())}}',
      "src/m/impl.test.ts": 'import {test} from "node:test";import assert from "node:assert/strict";import {Base} from "./impl.ts";class Probe extends Base{protected value():string{return "value"}}\n/** @tests Lifecycle\n * @covers value */\ntest("base lifecycle",()=>assert.equal(new Probe().run(),"value"));',
    });
    check(root);
    const source = fs.readFileSync(path.join(root, "src/m/impl.ts"), "utf8");
    for (const addition of ['extra():void{}', 'abstract extra():void;', 'static extra():void{}']) {
      writeFile(root, "src/m/impl.ts", source.replace('protected abstract', `${addition} protected abstract`));
      check(root, "E_CONTRACT_EXTRA_MEMBER");
    }
    writeFile(root, "src/m/impl.ts", source.replace('run():string', 'run(extra?:number):string'));
    check(root, "E_CONTRACT_SIGNATURE");
    writeFile(root, "src/m/impl.ts", source + '\nexport class Unbound extends Base{protected value():string{return "x"}}');
    check(root, "E_NOT_DESIGNED");
    writeFile(root, "src/m/impl.ts", source);
    fs.unlinkSync(path.join(root, "src/m/impl.test.ts"));
    check(root, "E_TEST_MISSING");
  }
});

const library = `export declare class Schema<T> {
  readonly shape:T;
  parse(input:unknown):T;
  refine():this;
  recursive():Schema<Schema<T>>;
}
export declare class Other<T> {readonly shape:T;parse(input:unknown):T;refine():this;recursive():Other<Other<T>>}
export declare function schema<T>(shape:T):Schema<T>;
`;
const schemaDesign = (body = "", tags = "@package-instance") => mdx('import type {Schema as LibrarySchema} from "library";',
  family, contract('Schema extends Rules, LibrarySchema<{id:string}>', body, tags));
const schemaSource = 'import {schema,Schema as LibrarySchema,Other} from "library";\n/** @implements Schema */\nexport const value=schema({id:""});';
const schemaFiles = {
  "package.json": JSON.stringify({ name: "app", type: "module", dependencies: { library: "1.0.0" } }),
  "node_modules/library/package.json": JSON.stringify({ name: "library", version: "1.0.0", types: "index.d.ts" }),
  "node_modules/library/index.d.ts": library,
  "src/m/impl.ts": schemaSource,
  "src/m/impl.test.ts": 'import {test} from "node:test";import assert from "node:assert/strict";import {value} from "./impl.ts";\n/** @tests Schema\n * @covers identity */\ntest("parses input",()=>assert.deepEqual(value.parse({id:"a"}),{id:"a"}));',
};

/** @tests Cli
 * @covers package-instances exact-surface exact-signatures contract-families package-types gate */
test("explicit package instances omit only inherited library methods and retain exact class arguments and declared members on TS5/6", t => {
  for (const compiler of compilers) {
    const root = project(t, compiler, schemaDesign(), schemaFiles);
    check(root);
    writeFile(root, "src/m/m.cage.mdx", schemaDesign('parse(input:unknown):{id:string};'));
    check(root);
    writeFile(root, "src/m/impl.ts", schemaSource.replace('id:""', 'id:1'));
    check(root, "E_TYPE_MISMATCH");
    writeFile(root, "src/m/m.cage.mdx", schemaDesign());
    check(root, "E_CONTRACT_SIGNATURE");
    for (const expression of [
      'Object.assign(schema({id:""}),{surplus():void{}})',
      'Object.assign(schema({id:""}),{parse(input:unknown):{id:string}{return {id:""}}})',
    ]) {
      writeFile(root, "src/m/impl.ts", schemaSource.replace('schema({id:""})', expression));
      check(root, "E_CONTRACT_EXTRA_MEMBER");
    }
    writeFile(root, "src/m/impl.ts", schemaSource.replace('schema({id:""})','new Other<{id:string}>()'));
    check(root, "E_CONTRACT_INSTANCE");
    writeFile(root, "src/m/impl.ts", schemaSource.replace('schema({id:""})','LibrarySchema'));
    check(root, "E_CONTRACT_INSTANCE");
    writeFile(root, "src/m/impl.ts", schemaSource.replace('const value=', 'const value:LibrarySchema<{id:string}> & Readonly<Pick<LibrarySchema<{id:string}>,"parse">>='));
    check(root, "E_CONTRACT_EXTRA_MEMBER");
    writeFile(root, "src/m/impl.ts", schemaSource.replace('/** @implements', 'class ProjectSchema extends LibrarySchema<{id:string}>{}\n/** @implements').replace('schema({id:""})','new ProjectSchema()'));
    check(root, "E_CONTRACT_INSTANCE");
    writeFile(root, "src/m/impl.ts", schemaSource.replace('/** @implements', 'interface Lookalike extends LibrarySchema<{id:string}>{}\ndeclare const fake:Lookalike;\n/** @implements').replace('schema({id:""})','fake'));
    check(root, "E_CONTRACT_INSTANCE");
    writeFile(root, "src/m/impl.ts", schemaSource);
    writeFile(root, "src/m/m.cage.mdx", schemaDesign('parse(input:string):{id:string};'));
    check(root, "E_CONTRACT_SIGNATURE");
    writeFile(root, "src/m/m.cage.mdx", mdx(contract('Plain', 'run():void;', '@package-instance')));
    check(root, "E_UNSUPPORTED_DECLARATION");
    writeFile(root, "src/m/m.cage.mdx", schemaDesign('', '@package-instance yes'));
    check(root, "E_TAG_FORMAT");
    writeFile(root, "src/m/m.cage.mdx", schemaDesign('', '@package-instance\n * @package-instance'));
    check(root, "E_TAG_FORMAT");
  }
});

function record(root: string) {
  const run = cli(root, "review", "Schema", "--format", "json", "--files", "all");
  assert.equal(run.code, 0, run.stdout);
  const packet = JSON.parse(run.stdout) as ReviewReport;
  writeFile(root, "verdict.json", JSON.stringify({ version: 1, verdicts: packet.contracts.map(c => ({
    contract: c.contract, fingerprint: c.fingerprint, findings: c.invariants.map(i => ({
      invariant: i.id, assessment: "adequate", reason: "Fixture attestation for invalidation and lock tests, not a review of a product library.",
      evidence: "src/m/impl.test.ts:4", suggestedChange: null,
    })),
  })) }));
  const recorded = cli(root, "review", "--record", "verdict.json");
  assert.equal(recorded.code, 0, recorded.stdout);
  return packet;
}

/** @tests Cli
 * @covers package-instances contract-families project-vocabulary package-types review-stale locks */
test("package-instance aliases, linked declarations, family promises and comparison boundaries remain review and lock material", t => {
  for (const compiler of compilers) {
    const root = project(t, compiler, schemaDesign(), schemaFiles);
    const external = designProject(t, {}, {});
    fs.renameSync(path.join(root, "node_modules/library"), path.join(external, "library"));
    fs.symlinkSync(path.join(external, "library"), path.join(root, "node_modules/library"), "dir");
    writeFile(root, "src/vocabulary.ts", 'import type {Schema} from "library";export type PayloadParser=Schema<{id:string}>;');
    writeFile(root, ".cage/config.json", JSON.stringify({version:1,coverage:"require",review:"require",designImportableTypes:["src/vocabulary.ts#PayloadParser"]}));
    writeFile(root, "src/m/m.cage.mdx", mdx('import type {PayloadParser} from "../vocabulary.ts";', family, contract('Schema extends Rules, PayloadParser', '', '@package-instance')));
    const packet = record(root);
    assert.ok(packet.files.some(file => file.path === "src/vocabulary.ts"));
    check(root);
    editFile(root, "src/m/m.cage.mdx", s=>s.replace('returns the input unchanged', 'returns exactly the input unchanged'));
    check(root, "E_REVIEW_STALE");
    record(root);
    editFile(root, "node_modules/library/index.d.ts", s=>s.replace('recursive():', 'added():void;recursive():'));
    check(root, "E_REVIEW_STALE");
    record(root);
    check(root);
    editFile(root, "src/m/m.cage.mdx", s=>s.replace('@contract', '@contract\n * @extendable'));
    assert.equal(cli(root, "lock").code, 0);
    editFile(root, "src/m/m.cage.mdx", s=>s.replace(' * @package-instance\n', ''));
    check(root, "E_LOCK_VIOLATION");
  }
});
