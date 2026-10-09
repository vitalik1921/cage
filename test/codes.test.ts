import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { CODES, formatCodes } from "../src/codes.ts";
import { cli, designProject } from "./helpers.ts";

const repository = path.join(import.meta.dirname, "..");

/** Every code the source can emit: the literals, and the review codes built from a level. */
function emittedCodes(): Set<string> {
  const codes = new Set<string>();
  for (const name of fs.readdirSync(path.join(repository, "src"))) {
    if (!name.endsWith(".ts") || name === "codes.ts") continue;
    const text = fs.readFileSync(path.join(repository, "src", name), "utf8");
    for (const match of text.matchAll(/"([EW]_[A-Z_]+)"/g)) codes.add(match[1]);
    for (const match of text.matchAll(/code\("([A-Z_]+)"\)/g)) for (const level of ["E", "W"]) codes.add(`${level}_REVIEW_${match[1]}`);
  }
  return codes;
}

/** @tests Codes
 * @covers legend */
test("every code the source emits is in the legend, and the legend in the reference", () => {
  const emitted = emittedCodes();
  assert.ok(emitted.size > 40, `${emitted.size} codes found`);
  for (const code of emitted) assert.ok(Object.hasOwn(CODES, code), `${code} is emitted but not in CODES`);
  for (const code of Object.keys(CODES)) assert.ok(emitted.has(code), `${code} is in CODES but never emitted`);
  const reference = fs.readFileSync(path.join(repository, "docs/reference.md"), "utf8");
  for (const [code, { means, then }] of Object.entries(CODES)) {
    assert.ok(reference.includes(`| \`${code}\` | ${means.replaceAll("|", "\\|")} | ${then.replaceAll("|", "\\|")} |`), `${code} is not in the reference's table as CODES has it`);
  }
  const output = formatCodes().trimEnd().split("\n");
  assert.equal(output.length, emitted.size);
  for (const [code, { means, then }] of Object.entries(CODES)) {
    const matching = output.filter((line) => line.trimStart().startsWith(`${code} `));
    assert.equal(matching.length, 1, `${code} must occur exactly once`);
    assert.equal(matching[0].trimStart().replace(/^\S+\s+/, ""), `${means}. Then: ${then}.`, code);
  }
});

/** @tests Cli
 * @covers codes */
test("cage codes prints one line per code, what it means and what to do, and takes no options", (t) => {
  const root = designProject(t, {});
  const run = cli(root, "codes");
  assert.equal(run.code, 0);
  assert.equal(run.stdout, formatCodes());
  const lines = run.stdout.trimEnd().split("\n");
  assert.equal(lines.length, Object.keys(CODES).length);
  assert.match(lines[0], /^E_CONFIG\s+.*\. Then: .*\.$/);
  assert.ok(lines.every((line) => /^[EW]_[A-Z_]+\s+/.test(line)));
  assert.match(cli(root, "codes", "--format", "json").stderr, /codes takes no options but --root and --config/);
  // The global options are no error: an agent that mirrors the hook's `--root` gets the legend.
  assert.equal(cli(root, "codes", "--root", ".").stdout, formatCodes());
});
