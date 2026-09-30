import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { checkLinking, contract, copyFixture, designFile, designProject, inFile, located, mdx } from "./helpers.ts";

const QUOTA = contract("Quota", "take(): boolean;", "@invariant empty Порожня квота відмовляє.", "@invariant consume Списує одиницю.", "@invariant race Не перевищує залишок.");
const SENDER = contract("Sender", "send(): void;", "@invariant once Надсилає один раз.");
const IMPLEMENTATIONS = "/** @implements Quota */\nexport const quota = { take: () => true };\n/** @implements Sender */\nexport const sender = { send: () => {} };\n";

const TEST_FILE = "src/m/contracts.test.ts";

/** A project with the Quota and Sender contracts, their implementations, and the given test files. */
function project(t: TestContext, tests: string | Record<string, string>): string {
  return designProject(t, { m: mdx(QUOTA, SENDER) }, { "src/m/implementations.ts": IMPLEMENTATIONS, ...(typeof tests === "string" ? { [TEST_FILE]: tests } : tests) });
}

const lines = (...text: string[]) => `${text.join("\n")}\n`;

/** Links every invariant, so that a test file under scrutiny can leave some out. */
const COMPLETE = lines(
  'import { describe, it } from "node:test";',
  "/** @tests Quota */",
  'describe("Quota", () => {',
  "  /** @covers empty consume race */",
  '  it("all", () => {});',
  "});",
  "/** @tests Sender */",
  'describe("Sender", () => {',
  "  /** @covers once */",
  '  it("once", () => {});',
  "});",
);

const links = (root: string) =>
  checkLinking(root)
    .linking.tests.filter((declaration) => declaration.location.file === TEST_FILE)
    .map(({ title, suitePath, contract, covers }) => `${[...suitePath, title].join(" > ")} [${contract}: ${covers.join(" ")}]`);

test("the plan fixture links eight test declarations to eight invariants", (t) => {
  const root = copyFixture(t, "vertical");
  const { linking, errors } = checkLinking(root);
  assert.deepEqual(errors, []);
  assert.deepEqual(
    linking.tests.map(({ contract, covers, suitePath, adapter, location }) => ({ contract, covers, suitePath, adapter, file: location.file })),
    [
      ...["quota", "limit", "quota-error", "sender-error"].map((id) => ({ contract: "Send", covers: [id], suitePath: ["SendService"], adapter: "node:test", file: "src/modules/campaigns/send.test.ts" })),
      ...["accounts", "empty", "consume", "race"].map((id) => ({ contract: "Quota", covers: [id], suitePath: ["MemoryQuota"], adapter: "node:test", file: "src/modules/quota/quota.test.ts" })),
    ],
  );
  assert.deepEqual(linking.tests[0].location, inFile(root, "src/modules/campaigns/send.test.ts", 'it("чекає'));
  assert.equal(linking.tests[0].title, "чекає на підтвердження квоти до передачі повідомлення");
});

test("declarations are recognised by their import from node:test, under any local name", (t) => {
  const root = project(
    t,
    lines(
      'import test, { describe as group, it as check, suite } from "node:test";',
      'import * as runner from "node:test";',
      "",
      "/** @tests Quota */",
      'group("aliases", () => {',
      "  /** @covers empty */",
      '  check("named alias", () => {});',
      "  /** @covers consume */",
      '  test("default import", () => {});',
      "  /** @covers race */",
      '  runner.it("namespace", () => {});',
      "});",
      "",
      "/** @tests Sender */",
      'suite("suite", () => {',
      "  /** @covers once */",
      "  runner.test(`template title`, () => {});",
      "});",
      "",
      "/** @tests Sender */",
      'runner.describe("namespace suite", () => {',
      "  /** @covers once */",
      '  test.it("member of the default export", () => {});',
      "});",
    ),
  );
  assert.deepEqual(checkLinking(root).errors, []);
  assert.deepEqual(links(root), [
    "aliases > named alias [Quota: empty]",
    "aliases > default import [Quota: consume]",
    "aliases > namespace [Quota: race]",
    "suite > template title [Sender: once]",
    "namespace suite > member of the default export [Sender: once]",
  ]);
});

test("a function that is merely named like a test function declares nothing", (t) => {
  const root = project(t, {
    "src/m/complete.test.ts": COMPLETE,
    [TEST_FILE]: lines(
      'import { describe } from "node:test";',
      'import { it as vitestIt } from "vitest";',
      "",
      "function it(_title: string, _run: () => void): void {}",
      "",
      "/** @tests Quota */",
      'describe("local it", () => {',
      '  it("not a test", () => {});',
      '  vitestIt("another runner", () => {});',
      "});",
      "",
      "function register(describe: (title: string, run: () => void) => void): void {",
      '  describe("a parameter", () => {});',
      "}",
      "register(() => {});",
    ),
  });
  assert.deepEqual(checkLinking(root).errors, []);
  assert.deepEqual(links(root), []);
});

test("nested suites inherit the contract; a nested @tests replaces it for its own suite", (t) => {
  const root = project(
    t,
    lines(
      'import { describe, it } from "node:test";',
      "",
      "/** @tests Quota */",
      'describe("outer", () => {',
      '  describe("inherits", () => {',
      "    /** @covers empty */",
      '    it("a", () => {});',
      "",
      "    /** @tests Sender */",
      '    describe("replaces", () => {',
      "      /** @covers once */",
      '      it("b", () => {});',
      "    });",
      "",
      "    /** @covers consume, race */",
      '    it("c", () => {});',
      "  });",
      '  it("in context, without @covers", () => {});',
      "});",
      "",
      'describe("no contract", () => {',
      '  it("an ordinary test", () => {});',
      "});",
    ),
  );
  const { linking, errors } = checkLinking(root);
  assert.deepEqual(errors, []);
  assert.deepEqual(links(root), [
    "outer > inherits > a [Quota: empty]",
    "outer > inherits > replaces > b [Sender: once]",
    "outer > inherits > c [Quota: consume race]",
    "outer > in context, without @covers [Quota: ]",
  ]);
  // Declarations in a contract context are counted; a test outside any is not the harness's.
  assert.equal(linking.tests.length, 4);
});

test("a test may cover several invariants, and an invariant may have several tests", (t) => {
  const root = project(
    t,
    lines(
      'import { describe, it } from "node:test";',
      "/** @tests Quota */",
      'describe("Quota", () => {',
      "  /**",
      "   * @covers empty consume",
      "   * @covers consume, race empty",
      "   */",
      '  it("many", () => {});',
      "  /** @covers empty */",
      '  it("again", () => {});',
      "});",
      "/** @tests Sender */",
      'describe("Sender", () => {',
      "  /** @covers once */",
      '  it("once", () => {});',
      "});",
    ),
  );
  assert.deepEqual(checkLinking(root).errors, []);
  assert.deepEqual(links(root), ["Quota > many [Quota: empty consume race]", "Quota > again [Quota: empty]", "Sender > once [Sender: once]"]);
});

test("a declaration counts whether or not the test would run: skip, todo, only, options, empty bodies", (t) => {
  const root = project(
    t,
    lines(
      'import assert from "node:assert/strict";',
      'import { describe, it, test } from "node:test";',
      "const later = () => {};",
      "",
      "/** @tests Quota */",
      'describe.skip("skipped suite", () => {',
      "  /** @covers empty */",
      '  it.skip("skipped", () => {});',
      "  /** @covers consume */",
      '  it.todo("no callback at all");',
      "  /** @covers race */",
      '  test("options", { skip: true, timeout: 10 }, later);',
      "});",
      "",
      "/** @tests Sender */",
      'describe.only("focused", { concurrency: true }, function () {',
      "  /** @covers once */",
      '  test.only("asserts nothing", () => {',
      "    assert.ok(true);",
      "  });",
      "});",
    ),
  );
  assert.deepEqual(checkLinking(root).errors, []);
  assert.deepEqual(links(root), [
    "skipped suite > skipped [Quota: empty]",
    "skipped suite > no callback at all [Quota: consume]",
    "skipped suite > options [Quota: race]",
    "focused > asserts nothing [Sender: once]",
  ]);
});

test("a declaration in a block or a loop is one declaration", (t) => {
  const root = project(
    t,
    lines(
      'import { describe, it } from "node:test";',
      "/** @tests Quota */",
      'describe("Quota", () => {',
      "  if (process.env.CI) {",
      "    /** @covers empty */",
      '    it("conditional", () => {});',
      "  }",
      "  for (const round of [1, 2, 3]) {",
      "    /** @covers consume race */",
      '    it("in a loop", () => void round);',
      "  }",
      "});",
      "/** @tests Sender */",
      'describe("Sender", () => {',
      "  /** @covers once */",
      '  it("once", () => {});',
      "});",
    ),
  );
  assert.deepEqual(checkLinking(root).errors, []);
  assert.deepEqual(links(root), ["Quota > conditional [Quota: empty]", "Quota > in a loop [Quota: consume race]", "Sender > once [Sender: once]"]);
});

test("tests may live in another module or in the tests directory", (t) => {
  const root = project(t, { "tests/integration/all.test.ts": COMPLETE, "src/other/unit.test.ts": COMPLETE });
  const { linking, errors } = checkLinking(root);
  assert.deepEqual(errors, []);
  assert.deepEqual([...new Set(linking.tests.map((declaration) => declaration.location.file))], ["src/other/unit.test.ts", "tests/integration/all.test.ts"]);
});

test("an invariant without a test declaration is an error of the implementation phase", (t) => {
  const root = project(
    t,
    lines('import { describe, it } from "node:test";', "/** @tests Quota */", 'describe("Quota", () => {', "  /** @covers empty */", '  it("empty", () => {});', "});"),
  );
  const { diagnostics } = checkLinking(root);
  assert.deepEqual(
    diagnostics.map(({ code, message, contract, invariant, file, line, column }) => ({ code, message, contract, invariant, file, line, column })),
    ["consume", "race"]
      .map((id) => ({ code: "E_TEST_MISSING", message: `Invariant Quota: ${id} has no linked test declaration.`, contract: "Quota", invariant: id, ...inFile(root, designFile("m"), `@invariant ${id}`) }))
      .concat([{ code: "E_TEST_MISSING", message: "Invariant Sender: once has no linked test declaration.", contract: "Sender", invariant: "once", ...inFile(root, designFile("m"), "@invariant once") }]),
  );
});

test("@tests and @covers must name what exists; an unknown contract is reported once", (t) => {
  const root = project(t, {
    "src/m/complete.test.ts": COMPLETE,
    [TEST_FILE]: lines(
      'import { describe, it } from "node:test";',
      "/** @tests Quot */",
      'describe("typo in the contract", () => {',
      "  /** @covers empty consume */",
      '  it("a", () => {});',
      "  /** @covers race */",
      '  it("b", () => {});',
      "});",
      "/** @tests Quota */",
      'describe("typo in the invariant", () => {',
      "  /** @covers empty emtpy once */",
      '  it("c", () => {});',
      "});",
    ),
  });
  const { errors } = checkLinking(root);
  assert.deepEqual(
    errors.map(({ code, message, line, column }) => ({ code, message, line, column })),
    [
      { code: "E_REFERENCE_UNKNOWN", message: "`@tests Quot`: there is no contract with this name.", ...position(root, "@tests Quot") },
      { code: "E_REFERENCE_UNKNOWN", message: '`@covers emtpy`: contract "Quota" has no invariant with this id.', ...position(root, "@covers empty emtpy") },
      // `once` is an invariant of Sender, not of the contract this suite is about.
      { code: "E_REFERENCE_UNKNOWN", message: '`@covers once`: contract "Quota" has no invariant with this id.', ...position(root, "@covers empty emtpy") },
    ],
  );
  assert.deepEqual(links(root), ["typo in the invariant > c [Quota: empty]"]);
});

const position = (root: string, needle: string) => {
  const { line, column } = inFile(root, TEST_FILE, needle);
  return { line, column };
};

test("a test may name its own contract with @tests: outside any suite, or in a suite of tests of several contracts", (t) => {
  const root = project(
    t,
    lines(
      'import { describe, it } from "node:test";',
      "",
"/**",
      " * @tests Sender",
      " * @covers once",
      " */",
      'it("a lone test", () => {});',
      "",
      'describe("one file, two contracts", () => {',
"  /**",
      "   * @tests Quota",
      "   * @covers empty consume",
      "   */",
      '  it("quota", () => {});',
      "",
      "  /**",
      "   * @tests Sender",
      "   * @covers once",
      "   */",
      '  it("sender", () => {});',
      "",
      "  /** @covers race */",
      '  it("still no contract here", () => {});',
      "});",
      "",
      "/** @tests Sender */",
      'describe("a suite of Sender", () => {',
"  /**",
      "   * @tests Quota",
      "   * @covers race",
      "   */",
      '  it("but this test is about Quota", () => {});',
      "",
      "  /** @tests Sender */",
      '  it("about the contract of the suite, covering nothing", () => {});',
      "",
      "  /** @covers once */",
      '  it("the suite still says Sender", () => {});',
      "});",
    ),
  );
  assert.deepEqual(checkLinking(root).errors.map(located), [{ code: "E_TEST_CONTEXT", file: TEST_FILE, ...position(root, "@covers race */") }]);
  assert.deepEqual(links(root), [
    "a lone test [Sender: once]",
    "one file, two contracts > quota [Quota: empty consume]",
    "one file, two contracts > sender [Sender: once]",
    "a suite of Sender > but this test is about Quota [Quota: race]",
    "a suite of Sender > about the contract of the suite, covering nothing [Sender: ]",
    "a suite of Sender > the suite still says Sender [Sender: once]",
  ]);
});

test("a rejected @tests on a test is one error, whatever its @covers names", (t) => {
  const root = project(
    t,
    lines(
      'import { it } from "node:test";',
      "/**",
      " * @tests Quota Sender",
      " * @covers empty",
      " */",
      'it("two contracts", () => {});',
      "/**",
      " * @tests Quota",
      " * @tests Sender, the second one",
      " * @covers consume",
      " */",
      'it("twice", () => {});',
      "/**",
      " * @tests Nobody",
      " * @covers race",
      " */",
      'it("unknown", () => {});',
      "/**",
      " * @tests Sender",
      " * @covers once",
      " */",
      'it("fine", () => {});',
    ),
  );
  assert.deepEqual(checkLinking(root).errors.map(located), [
    { code: "E_TAG_FORMAT", file: TEST_FILE, ...position(root, "@tests Quota Sender") },
    { code: "E_TAG_FORMAT", file: TEST_FILE, ...position(root, "@tests Sender, the second one") },
    { code: "E_REFERENCE_UNKNOWN", file: TEST_FILE, ...position(root, "@tests Nobody") },
  ]);
});

test("tags in the wrong place of a test file are errors", (t) => {
  const root = project(t, {
    "src/m/complete.test.ts": COMPLETE,
    [TEST_FILE]: lines(
      'import { describe, it, before } from "node:test";',
      "",
      "/** @covers empty */",
      'it("no suite, so no contract", () => {});',
      "",
      "/**",
      " * @tests Quota",
      " * @covers consume",
      " */",
      'describe("covers on a suite", () => {',
      "  /** @covers race */",
      "  before(() => {});",
      "",
      "  /** @covers empty consume */",
      "  function helper(): void {}",
      "  helper();",
      "",
      '  it("subtests are not declarations", async (t) => {',
      "    /** @covers consume race */",
      '    await t.test("subtest", () => {});',
      "  });",
      "});",
      "",
      "/** @implements Quota */",
      'describe("an implementation tag", () => {});',
    ),
  });
  assert.deepEqual(checkLinking(root).errors.map(located), [
    { code: "E_TEST_CONTEXT", file: TEST_FILE, ...position(root, "@covers empty */") },
    { code: "E_TAG_LOCATION", file: TEST_FILE, ...position(root, "@covers consume") },
    { code: "E_TAG_LOCATION", file: TEST_FILE, ...position(root, "@covers race */") },
    { code: "E_TAG_LOCATION", file: TEST_FILE, ...position(root, "@covers empty consume */") },
    { code: "E_TAG_LOCATION", file: TEST_FILE, ...position(root, "@covers consume race */") },
    { code: "E_TAG_LOCATION", file: TEST_FILE, ...position(root, "@implements Quota") },
  ]);
});

test("annotated declarations in a form that cannot be read statically are rejected", (t) => {
  const root = project(t, {
    "src/m/complete.test.ts": COMPLETE,
    [TEST_FILE]: lines(
      'import { describe, it } from "node:test";',
      'const name = "computed";',
      "const body = () => {};",
      "",
      "/** @tests Quota */",
      "describe(`suite ${name}`, () => {",
      "  /** @covers empty */",
      "  it(name, () => {});",
      "});",
      "",
      "/** @tests Quota */",
      'describe("callback by reference", body);',
      "",
      "function defineSuite(title: string): void {",
      "  /** @tests Sender */",
      "  describe(title, () => {",
      "    /** @covers once */",
      '    it("generated", () => {});',
      "  });",
      "}",
      'defineSuite("dynamic");',
      "",
      "/**",
      " * An awaited call is an expression, not a declaration.",
      " * @tests Quota",
      " */",
      'await describe("awaited", () => {});',
      "",
      "/** @tests Quota */",
      'describe("expression body", () => it("not read", () => {}));',
      "",
      "// Without tags, the same forms are none of the harness's business.",
      "describe(`plain ${name}`, body);",
      "it(name);",
    ),
  });
  assert.deepEqual(checkLinking(root).errors.map(located), [
    { code: "E_UNSUPPORTED_DECLARATION", file: TEST_FILE, ...position(root, "`suite ${name}`") },
    { code: "E_UNSUPPORTED_DECLARATION", file: TEST_FILE, ...position(root, "name, () => {});") },
    { code: "E_UNSUPPORTED_DECLARATION", file: TEST_FILE, ...position(root, 'describe("callback by reference"') },
    { code: "E_TAG_LOCATION", file: TEST_FILE, ...position(root, "@tests Sender") },
    { code: "E_TAG_LOCATION", file: TEST_FILE, ...position(root, "@covers once") },
    { code: "E_TAG_LOCATION", file: TEST_FILE, ...position(root, " * @tests Quota"), column: position(root, " * @tests Quota").column + " * ".length },
    { code: "E_UNSUPPORTED_DECLARATION", file: TEST_FILE, ...position(root, 'describe("expression body"') },
  ]);
});

test("malformed @tests and @covers are format errors, without follow-up errors", (t) => {
  const root = project(t, {
    "src/m/complete.test.ts": COMPLETE,
    [TEST_FILE]: lines(
      'import { describe, it } from "node:test";',
      "/** @tests Quota Sender */",
      'describe("two contracts", () => {',
      "  /** @covers empty */",
      '  it("not reported again", () => {});',
      "});",
      "/**",
      " * @tests Quota",
      " * @tests Sender",
      " */",
      'describe("twice", () => {});',
      "/** @tests */",
      'describe("nothing", () => {});',
      "/** @tests Quota */",
      'describe("covers", () => {',
      "  /** @covers */",
      '  it("none", () => {});',
      "  /** @covers Empty */",
      '  it("not an id", () => {});',
      "  /** @covers: empty */",
      '  it("punctuation", () => {});',
      "  /**",
      "   * @covers empty",
      "   * @bogus",
      "   */",
      '  it("unknown tag in a managed comment", () => {});',
      "});",
    ),
  });
  assert.deepEqual(checkLinking(root).errors.map(located), [
    { code: "E_TAG_FORMAT", file: TEST_FILE, ...position(root, "@tests Quota Sender") },
    { code: "E_TAG_FORMAT", file: TEST_FILE, ...position(root, "@tests Sender") },
    { code: "E_TAG_FORMAT", file: TEST_FILE, ...position(root, "@tests */") },
    { code: "E_TAG_FORMAT", file: TEST_FILE, ...position(root, "@covers */") },
    { code: "E_TAG_FORMAT", file: TEST_FILE, ...position(root, "@covers Empty") },
    { code: "E_TAG_FORMAT", file: TEST_FILE, ...position(root, "@covers: empty") },
    { code: "E_UNKNOWN_TAG", file: TEST_FILE, ...position(root, "@bogus") },
  ]);
});

test("a misplaced @covers is one error: the invariant it names is not also reported as untested", (t) => {
  const root = project(
    t,
    lines(
      'import { describe, it } from "node:test";',
      "/** @tests Sender */",
      'describe("Sender", () => {',
      '  it("outer", async (t) => {',
      "    /** @covers once */",
      '    await t.test("a subtest is not a declaration", () => {});',
      "  });",
      "});",
      "/** @covers empty consume race */",
      'it("outside any suite", () => {});',
    ),
  );
  assert.deepEqual(checkLinking(root).errors.map(located), [
    { code: "E_TAG_LOCATION", file: TEST_FILE, ...positionIn(root, "@covers once") },
    { code: "E_TEST_CONTEXT", file: TEST_FILE, ...positionIn(root, "@covers empty consume race") },
  ]);
});

test("a link that was written but rejected is not also reported as missing", (t) => {
  // No other test file: every invariant depends on this one.
  const glued = project(
    t,
    lines(
      'import { describe, it } from "node:test";',
      "/** @tests Quota */",
      'describe("Quota", () => {',
      "  /** @covers: empty consume */",
      '  it("glued punctuation", () => {});',
      "});",
      "/**",
      " * @tests Sender",
      " * @tests Quota",
      " */",
      'describe("two tags", () => {',
      "  /** @covers once */",
      '  it("under a rejected suite", () => {});',
      "});",
    ),
  );
  // `race` was not mentioned by the first suite, but the second, rejected one names Quota as a whole.
  assert.deepEqual(checkLinking(glued).errors.map(located), [
    { code: "E_TAG_FORMAT", file: TEST_FILE, ...positionIn(glued, "@covers: empty consume") },
    { code: "E_TAG_FORMAT", file: TEST_FILE, ...positionIn(glued, " * @tests Quota"), column: positionIn(glued, " * @tests Quota").column + " * ".length },
  ]);

  const partial = project(
    t,
    lines('import { describe, it } from "node:test";', "/** @tests Quota */", 'describe("Quota", () => {', "  /** @covers: empty */", '  it("glued punctuation", () => {});', "});"),
  );
  assert.deepEqual(
    checkLinking(partial).errors.map(({ code, invariant }) => ({ code, invariant })),
    [
      { code: "E_TEST_MISSING", invariant: "consume" },
      { code: "E_TEST_MISSING", invariant: "race" },
      { code: "E_TEST_MISSING", invariant: "once" },
      { code: "E_TAG_FORMAT", invariant: undefined },
    ],
  );

  const broken = project(t, lines('import { describe, it } from "node:test";', "/** @tests Quota */", 'describe("broken", () => {', "  /** @covers empty */", '  it("unclosed", () => {', "});"));
  // The file cannot be read, but it says it tests Quota; nothing says anything about Sender.
  assert.deepEqual(
    checkLinking(broken).errors.map(({ code, contract }) => ({ code, contract })),
    [
      { code: "E_TEST_MISSING", contract: "Sender" },
      { code: "E_TYPESCRIPT", contract: undefined },
    ],
  );
});

const positionIn = (root: string, needle: string) => {
  const { line, column } = inFile(root, TEST_FILE, needle);
  return { line, column };
};

test("a test file with syntax errors is reported, not guessed at", (t) => {
  const root = project(t, {
    "src/m/complete.test.ts": COMPLETE,
    [TEST_FILE]: lines('import { describe, it } from "node:test";', "/** @tests Quota */", 'describe("broken", () => {', "  /** @covers empty */", '  it("unclosed", () => {', "});"),
  });
  const errors = checkLinking(root).errors;
  assert.ok(errors.length > 0);
  assert.ok(errors.every((error) => error.code === "E_TYPESCRIPT" && error.file === TEST_FILE));
});
