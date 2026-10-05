import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultConfig, loadConfig } from "../src/config.ts";
import { copyFixture, writeFile } from "./helpers.ts";

const problems = (root: string, configPath?: string) =>
  loadConfig(root, configPath).diagnostics.map(({ code, file, message }) => ({ code, file, message }));

/** @tests ConfigLoader
 * @covers defaults */
test("defaults apply when there is no .cage/config.json", (t) => {
  const root = copyFixture(t, "vertical");
  assert.deepEqual(loadConfig(root), { config: defaultConfig, diagnostics: [] });
});

/** @tests ConfigLoader
 * @covers defaults */
test(".cage/config.json is found; given fields replace the defaults, the rest stay", (t) => {
  const root = copyFixture(t, "vertical");
  writeFile(root, ".cage/config.json", JSON.stringify({ version: 1, exclude: ["**/mail/**"], tsconfig: "tsconfig.design.json" }));
  assert.deepEqual(loadConfig(root), {
    config: { ...defaultConfig, exclude: ["**/mail/**"], tsconfig: "tsconfig.design.json" },
    diagnostics: [],
  });
  // The bounds merge field by field: a depth given alone keeps the default file limit and exclusions.
  writeFile(root, ".cage/config.json", JSON.stringify({ version: 1, reviewDependencies: { depth: 1 } }));
  assert.deepEqual(loadConfig(root).config.reviewDependencies, { depth: 1, maxFiles: 40, exclude: [] });
});

test("--config is relative to the project root, and must exist", (t) => {
  const root = copyFixture(t, "vertical");
  writeFile(root, "tools/design.json", JSON.stringify({ version: 1, designs: ["lib/**/*.cage.mdx"] }));
  assert.deepEqual(loadConfig(root, "tools/design.json").config.designs, ["lib/**/*.cage.mdx"]);

  const [missing] = problems(root, "tools/nope.json");
  assert.equal(missing.code, "E_CONFIG");
  assert.equal(missing.file, "tools/nope.json");
  assert.match(missing.message, /^cannot read the configuration: ENOENT/);
});

/** @tests ConfigLoader
 * @covers fields */
test("an invalid configuration is reported field by field", (t) => {
  const root = copyFixture(t, "vertical");
  const check = (content: string) => {
    writeFile(root, ".cage/config.json", content);
    return problems(root).map(({ code, file, message }) => {
      assert.equal(code, "E_CONFIG");
      assert.equal(file, ".cage/config.json");
      return message;
    });
  };

  assert.match(check("{ nope")[0], /^invalid JSON: /);
  // With a problem the defaults are returned, so that a broken file never half-applies.
  assert.deepEqual(loadConfig(root).config, defaultConfig);
  assert.deepEqual(check("[]"), ["not a JSON object"]);
  assert.deepEqual(check("{}"), ['"version" must be 1']);
  assert.deepEqual(check('{ "version": 2 }'), ['"version" must be 1']);
  assert.deepEqual(check('{ "version": 1, "testAdapter": "jest" }'), ['"testAdapter" must be "node:test" or "vitest"']);
  assert.deepEqual(check('{ "version": 1, "designs": "src/**", "tsconfig": "", "exclude": [1] }'), [
    '"designs" must be an array of non-empty strings',
    '"tsconfig" must be a non-empty string',
    '"exclude" must be an array of non-empty strings',
  ]);
  assert.deepEqual(check('{ "version": 1, "output": "generated", "toString": 1 }'), ['unknown field "output"', 'unknown field "toString"']);
});
