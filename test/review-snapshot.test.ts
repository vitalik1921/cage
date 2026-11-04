import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type ts from "typescript";
import { collectMaterial, createFileReader, fingerprintOf, partsForReview } from "../src/review-material.ts";
import { checkLinking, contract, designProject, editFile, mdx } from "./helpers.ts";

/** @tests Cli
 * @covers review-packet review-dependency-relevant review-dependency-isolated review-fingerprint-legacy review-code-trivia */
test("contracts share parsed review snapshots without sharing dependency selections or retaining files across commands on TS5/6", t => {
  for (const version of ["typescript-5", "typescript"]) {
    const names = Array.from({ length: 8 }, (_, i) => `Port${i}`);
    const root = designProject(t, { work: mdx(...names.map(name => contract(name, "(value: number): number;", "@invariant value Returns the selected value."))) }, {
      "src/work/impl.ts": 'import { values } from "./shared.ts";\n' + names.map((name, i) => `/** @implements ${name} */\nexport const impl${i} = (value: number): number => values.field${i} + value;`).join("\n"),
      "src/work/shared.ts": "export const values = { " + names.map((_, i) => `field${i}: ${i}`).join(", ") + ", spare: 100 };\n",
      "src/work/cases.test.ts": 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { ' + names.map((_, i) => `impl${i}`).join(", ") + ' } from "./impl.ts";\n' + names.flatMap((name, i) => Array.from({ length: 4 }, (_, n) => `/** @tests ${name}\n * @covers value */\ntest("${name} case ${n}", () => { assert.equal(impl${i}(${n}), ${i + n}); });`)).join("\n"),
    });
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.symlinkSync(path.resolve("node_modules", version), path.join(root, "node_modules/typescript"), "dir");
    const result = checkLinking(root);
    assert.deepEqual(result.errors, []);
    const compiler = result.compiler!.ts;
    const snapshots = new Set(["impl.ts", "cases.test.ts", "shared.ts"].map(file => fs.readFileSync(path.join(root, "src/work", file), "utf8")));
    let parses = 0;
    result.compiler!.ts = new Proxy(compiler, { get(target, key, receiver) {
      if (key === "createSourceFile") return (...args: Parameters<typeof ts.createSourceFile>) => {
        // Object-member fingerprints also parse synthesized shells; count the
        // original file snapshots, not those separate comparison expressions.
        if (snapshots.has(args[1])) parses++;
        return compiler.createSourceFile(...args);
      };
      return Reflect.get(target, key, receiver);
    } });
    const reader = () => createFileReader(root, [], result.linking.sources).read;
    const read = reader();
    const materials = names.map(name => collectMaterial(result, name, read));
    assert.equal(parses, 3, "implementation, tests and shared dependency must each be parsed once for the whole packet");
    for (const [i, material] of materials.entries()) {
      const dependency = material.parts.find(part => part.key === "dependency src/work/shared.ts")!;
      assert.match(dependency.text, new RegExp(`field${i}: ${i}`));
      assert.ok(dependency.fingerprintText!.includes(`field${i}`));
      assert.ok(!dependency.fingerprintText!.includes("spare"));
      for (let other = 0; other < names.length; other++) if (other !== i) assert.ok(!dependency.fingerprintText!.includes(`field${other}`));
      // Independent collection supplies the same complete bytes and ranges,
      // including the older whole-object fingerprint algorithms.
      const isolated = collectMaterial(result, names[i], reader());
      assert.deepEqual(material.parts, isolated.parts);
      for (const format of [undefined, "sha256:code-v1:old", "sha256:old"]) {
        assert.deepEqual(fingerprintOf(material.parts, format), fingerprintOf(isolated.parts, format));
        assert.deepEqual(partsForReview(material.parts, format), partsForReview(isolated.parts, format));
      }
    }
    const fingerprints = materials.map(material => fingerprintOf(material.parts).fingerprint);
    editFile(root, "src/work/shared.ts", text => text.replace("spare: 100", "spare: 101"));
    const fresh = reader();
    assert.deepEqual(names.map(name => fingerprintOf(collectMaterial(result, name, fresh).parts).fingerprint), fingerprints);
    editFile(root, "src/work/shared.ts", text => text.replace("field0: 0", "field0: 99"));
    const changed = reader();
    const after = names.map(name => fingerprintOf(collectMaterial(result, name, changed).parts).fingerprint);
    assert.notEqual(after[0], fingerprints[0]);
    assert.deepEqual(after.slice(1), fingerprints.slice(1), "a fresh command sees the changed member without widening other contracts' selections");
  }
});
