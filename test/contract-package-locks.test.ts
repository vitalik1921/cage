import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { CheckReport } from "../src/check.ts";
import { cli, data, designProject, editFile, mdx, readFile } from "./helpers.ts";

// A lock holds the package types its declaration depends on, also when they come through a design alias or a base:
// a change of a helper type in the package changes the locked declaration though its written signature does not.

const lines = (...text: string[]) => `${text.join("\n")}\n`;
const COMPILERS = ["typescript-5", "typescript"] as const;
const KIT = "node_modules/kit/index.d.ts";
const OTHER = "node_modules/other-kit/index.d.ts";

const locked = (tag: "final" | "extendable", kind: "contract" | "data", name: string, declaration: string, invariant = "") =>
  lines("/**", ` * @${kind}`, ` * @${tag}`, ` * @description ${name}.`, ...(invariant ? [` * @invariant ${invariant}`] : []), " */", declaration);

function project(t: TestContext, compiler: (typeof COMPILERS)[number]): string {
  const root = designProject(t, {
    shared: mdx(lines('import type { Base } from "kit";', "", data("Shared", "Base"))),
    port: mdx(lines(
      'import type { Base } from "kit";',
      'import type { Spare } from "other-kit";',
      'import type { Shared } from "../shared/shared.cage.mdx";',
      "",
      // Direct use.
      data("Direct", "Base").replace("@data", "@data\n * @final"),
      "",
      // Behind a local data alias, inherited.
      data("Bridge", "Base"),
      "",
      locked("final", "contract", "Port", "export interface Port extends Bridge {}", "reads Reads a row."),
      "",
      // Behind another design's alias: as a base, and as a member type of an extendable data type.
      locked("final", "contract", "Remote", "export interface Remote extends Shared {}", "reads Reads a row."),
      "",
      locked("extendable", "data", "Holder", "export interface Holder {\n  item: Shared;\n}"),
      "",
      // The module imports another package; nothing locked uses it.
      data("Unused", "Spare"),
      "",
      locked("final", "data", "Plain", "export type Plain = string;"),
    )),
  }, {
    "node_modules/kit/package.json": JSON.stringify({ name: "kit", version: "1.0.0", exports: { ".": { types: "./index.d.ts", default: "./index.js" } } }),
    "node_modules/kit/index.js": 'throw new Error("kit was executed");\n',
    [KIT]: lines("export interface Row { value: string }", "export interface Base { read(): Row }"),
    "node_modules/other-kit/package.json": JSON.stringify({ name: "other-kit", version: "2.0.0", types: "index.d.ts" }),
    [OTHER]: "export interface Spare { size: number }\n",
  });
  fs.symlinkSync(path.resolve(import.meta.dirname, "../node_modules", compiler), path.join(root, "node_modules/typescript"), "dir");
  return root;
}

function lockDiagnostics(root: string) {
  const { stdout } = cli(root, "check", "--phase", "design", "--format", "json");
  const report = JSON.parse(stdout) as CheckReport;
  assert.deepEqual(report.diagnostics.filter((diagnostic) => diagnostic.severity === "error" && !diagnostic.code.startsWith("E_LOCK")), []);
  return report.diagnostics.filter((diagnostic) => diagnostic.code.startsWith("E_LOCK") || diagnostic.code === "W_LOCK_UNRECORDED");
}

/** @tests Cli
 * @covers package-types contract-inheritance locks */
test("a lock captures the package types a declaration uses directly, behind local and imported design aliases and through bases", (t) => {
  for (const compiler of COMPILERS) {
    const root = project(t, compiler);
    assert.equal(cli(root, "lock").code, 0, compiler);
    const recorded = readFile(root, ".cage/lock.json");
    const members = Object.fromEntries((JSON.parse(recorded).locks as { name: string; members: Record<string, string> }[]).map((entry) => [entry.name, entry.members]));
    const kit = members.Direct[":package kit"];
    assert.match(kit, /^sha256:types-v2:[0-9a-f]{64}$/, compiler);
    for (const name of ["Direct", "Port", "Remote", "Holder"]) assert.equal(members[name][":package kit"], kit, `${compiler} ${name}`);
    // A package the module imports but nothing locked reaches is not part of any lock.
    for (const [name, recordedMembers] of Object.entries(members)) {
      assert.deepEqual(Object.keys(recordedMembers).filter((key) => key.startsWith(":package ")), name === "Plain" ? [] : [":package kit"], `${compiler} ${name}`);
    }

    // Without a change, the record is byte-stable and nothing is reported.
    assert.deepEqual(lockDiagnostics(root), [], compiler);
    assert.equal(cli(root, "lock").code, 0, compiler);
    assert.equal(readFile(root, ".cage/lock.json"), recorded, compiler);

    // The unused package changes: no lock is about it.
    editFile(root, OTHER, (text) => text.replace("size: number", "size: string"));
    assert.deepEqual(lockDiagnostics(root), [], compiler);

    // A helper type of the package changes; no written signature does. Every lock that reaches it is violated, final and extendable alike.
    editFile(root, KIT, (text) => text.replace("value: string", "value: number"));
    const violations = lockDiagnostics(root);
    assert.deepEqual(violations.map((diagnostic) => `${diagnostic.code} ${diagnostic.message.split("\n")[0]}`).sort(), [
      'E_LOCK_VIOLATION Contract "Port" is `@final`',
      'E_LOCK_VIOLATION Contract "Remote" is `@final`',
      'E_LOCK_VIOLATION Data type "Direct" is `@final`',
      'E_LOCK_VIOLATION Data type "Holder" is `@extendable`',
    ], compiler);
    for (const violation of violations) assert.match(violation.message, new RegExp(`\\nthe declarations of package kit it uses changed; it was: ${kit}$`), compiler);
    // `cage lock` never rewrites what is recorded.
    cli(root, "lock");
    assert.equal(readFile(root, ".cage/lock.json"), recorded, compiler);

    // Back as it was: the lock holds again.
    editFile(root, KIT, (text) => text.replace("value: number", "value: string"));
    assert.deepEqual(lockDiagnostics(root), [], compiler);
  }
});

/** @tests Cli
 * @covers package-types contract-inheritance locks */
test("the package lock digest is the same on TypeScript 5 and 6", (t) => {
  const digests = COMPILERS.map((compiler) => {
    const root = project(t, compiler);
    assert.equal(cli(root, "lock").code, 0);
    return readFile(root, ".cage/lock.json");
  });
  assert.equal(digests[0], digests[1]);
  assert.ok(digests[0].includes(`":package kit"`));
});
