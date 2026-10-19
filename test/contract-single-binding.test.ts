import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { checkLinking, cli, contract, designProject, inFile, located, mdx } from "./helpers.ts";

const COMPILERS = ["typescript-5", "typescript"] as const;

/** A project with contracts A, B and Factory, checked with the given compiler. */
function project(t: TestContext, compiler: (typeof COMPILERS)[number], files: Record<string, string>): string {
  const root = designProject(t, { m: mdx(contract("A", "run(): void;"), contract("B", "stop(): void;"), contract("Factory", "create(): string;")) }, files);
  fs.mkdirSync(path.join(root, "node_modules"));
  fs.symlinkSync(path.resolve("node_modules", compiler), path.join(root, "node_modules/typescript"), "dir");
  return root;
}

const CLASS = 'export class Service { run():void{} stop():void{} static create():string{return "ok"} }';

/** `check` fails and the Stop hook gate blocks with the code in its feedback. */
function assertBlocked(root: string, code: string) {
  const check = cli(root, "check");
  assert.equal(check.code, 1);
  assert.match(check.stdout, new RegExp(code));
  const gate = cli(root, "gate");
  assert.equal(gate.code, 2);
  assert.match(gate.stderr, new RegExp(code));
}

/** @tests Cli
 * @covers exact-surface */
test("an @implements tag names exactly one contract; lists and repeated tags are rejected on TS5/TS6", (t) => {
  for (const compiler of COMPILERS) {
    const cases: Record<string, string> = {
      spaces: "/** @implements A B */",
      commas: "/** @implements A, B */",
      same: "/** @implements A A */",
      trailing: "/** @implements A, */",
      tags: "/**\n * @implements A\n * @implements B\n */",
      repeated: "/**\n * @implements A\n * @implements A\n */",
      statics: "/** @implements-static Factory A */",
      "repeated statics": "/**\n * @implements-static Factory\n * @implements-static Factory\n */",
    };
    for (const [name, comment] of Object.entries(cases)) {
      const file = "src/m/service.ts";
      const root = project(t, compiler, { [file]: `${comment}\n${CLASS}` });
      const result = checkLinking(root);
      assert.equal(result.typescript.version, compiler === "typescript-5" ? "5.9.3" : "6.0.3");
      const tagged = comment.includes("@implements-static") ? "@implements-static" : "@implements";
      // The second tag when there is one, else the only tag.
      const lines = fs.readFileSync(path.join(root, file), "utf8").split("\n");
      const line = lines.findLastIndex((candidate) => candidate.includes(`${tagged} `));
      const expected = { file, line: line + 1, column: lines[line].indexOf(tagged) + 1 };
      const formats = result.errors.filter((d) => d.code === "E_TAG_FORMAT");
      assert.deepEqual(formats.map(located), [{ code: "E_TAG_FORMAT", ...expected }], `${compiler} ${name}`);
      assert.match(formats[0].message, /one contract|without a contract name/, `${compiler} ${name}`);
      // A rejected binding links nothing for its surface, and its contracts are not also reported as missing.
      const surface = tagged === "@implements-static" ? "static" : undefined;
      assert.deepEqual(result.linking.implementations.filter((i) => i.surface === surface), [], `${compiler} ${name}`);
      const missing = result.errors.filter((d) => d.code === "E_IMPLEMENTATION_MISSING").map((d) => d.contract).sort();
      const written = new Set(comment.match(/\b(A|B|Factory)\b/g));
      assert.deepEqual(missing, ["A", "B", "Factory"].filter((c) => !written.has(c)), `${compiler} ${name}`);
      assert.ok(!result.errors.some((d) => d.code === "E_IMPLEMENTATION_DUPLICATE"), `${compiler} ${name}`);
      if (name === "spaces") assertBlocked(root, "E_TAG_FORMAT");
    }
  }
});

/** @tests Cli
 * @covers exact-surface */
test("instance and static surfaces bind one contract each, never the same one on TS5/TS6", (t) => {
  for (const compiler of COMPILERS) {
    const file = "src/m/service.ts";
    const separate = project(t, compiler, {
      [file]: `/**\n * @implements A\n * @implements-static Factory\n */\n${CLASS.replace(" stop():void{}", "")}`,
      "src/m/b.ts": "/** @implements B */\nexport const b = { stop(): void {} };",
    });
    const ok = checkLinking(separate);
    assert.deepEqual(ok.errors, [], compiler);
    assert.equal(ok.typescript.version, compiler === "typescript-5" ? "5.9.3" : "6.0.3");
    assert.deepEqual(ok.linking.implementations.map((i) => [i.contract, i.name, i.surface ?? "instance"]).sort(), [["A", "Service", "instance"], ["B", "b", "instance"], ["Factory", "Service", "static"]], compiler);

    // A list on either surface rejects the declaration's bindings: one diagnostic, no surface checked alone, nothing reported missing.
    for (const comment of ["@implements A\n * @implements-static Factory B", "@implements A B\n * @implements-static Factory"]) {
      const mixed = project(t, compiler, { [file]: `/**\n * ${comment}\n */\n${CLASS}` });
      const mixedResult = checkLinking(mixed);
      const listed = comment.includes("Factory B") ? "@implements-static" : "@implements A B";
      assert.deepEqual(mixedResult.errors.map(located), [{ code: "E_TAG_FORMAT", ...inFile(mixed, file, listed) }], `${compiler} ${comment}`);
      assert.deepEqual(mixedResult.linking.implementations, [], `${compiler} ${comment}`);
    }

    // One contract on both surfaces of one class is ambiguous: neither binding is kept, no missing implementation follows.
    const both = project(t, compiler, { [file]: `/**\n * @implements A\n * @implements-static A\n */\n${CLASS}` });
    const bothResult = checkLinking(both);
    const formats = bothResult.errors.filter((d) => d.code === "E_TAG_FORMAT");
    assert.deepEqual(formats.map(located), [{ code: "E_TAG_FORMAT", ...inFile(both, file, "@implements-static") }], compiler);
    assert.match(formats[0].message, /both surfaces/, compiler);
    assert.deepEqual(bothResult.linking.implementations, [], compiler);
    assert.deepEqual(bothResult.errors.filter((d) => d.code === "E_IMPLEMENTATION_MISSING").map((d) => d.contract).sort(), ["B", "Factory"], compiler);
    assertBlocked(both, "E_TAG_FORMAT");
  }
});

/** @tests Cli
 * @covers exact-surface */
test("a contract has at most one direct implementation; the later ones point to the first on TS5/TS6", (t) => {
  for (const compiler of COMPILERS) {
    // Written in reverse path order: the first implementation is the first by path, not by discovery.
    const root = project(t, compiler, {
      "src/m/z.ts": "/** @implements A */\nexport const z = { run(): void {} };",
      "src/m/y.ts": "/** @implements-static A */\nexport class Y { static run(): void {} }",
      "src/m/a.ts": "/** @implements A */\nexport const a = { run(): void {} };\n/** @implements B */\nexport const b = { stop(): void {} };",
    });
    const result = checkLinking(root);
    assert.equal(result.typescript.version, compiler === "typescript-5" ? "5.9.3" : "6.0.3");
    const duplicates = result.errors.filter((d) => d.code === "E_IMPLEMENTATION_DUPLICATE");
    const first = inFile(root, "src/m/a.ts", "@implements A");
    assert.deepEqual(duplicates.map(located), [
      { code: "E_IMPLEMENTATION_DUPLICATE", ...inFile(root, "src/m/y.ts", "@implements-static A") },
      { code: "E_IMPLEMENTATION_DUPLICATE", ...inFile(root, "src/m/z.ts", "@implements A") },
    ], compiler);
    for (const duplicate of duplicates) {
      assert.equal(duplicate.contract, "A");
      assert.deepEqual(duplicate.related, [{ message: "the first implementation", ...first }]);
      assert.match(duplicate.message, /already implements/);
    }
    // Every implementation is still compared with the contract; the missing implementation error is unchanged.
    assert.deepEqual(result.linking.implementations.map((i) => `${i.contract}:${i.name}:${i.compatible}`).sort(), ["A:Y:true", "A:a:true", "A:z:true", "B:b:true"]);
    assert.deepEqual(result.errors.filter((d) => d.code === "E_IMPLEMENTATION_MISSING").map((d) => d.contract), ["Factory"]);
    assert.deepEqual(result.errors.map((d) => d.code).sort(), ["E_IMPLEMENTATION_DUPLICATE", "E_IMPLEMENTATION_DUPLICATE", "E_IMPLEMENTATION_MISSING"]);
    // The same diagnostics on a second run.
    assert.deepEqual(checkLinking(root).diagnostics, result.diagnostics);
    assertBlocked(root, "E_IMPLEMENTATION_DUPLICATE");
  }
});
