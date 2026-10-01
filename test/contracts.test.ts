import assert from "node:assert/strict";
import path from "node:path";
import { test, type TestContext } from "node:test";
import {
  at,
  CAMPAIGNS,
  checkDesigns,
  contract,
  copyFixture,
  data,
  designErrors,
  designFile,
  designProject,
  editFile,
  fixturesDir,
  inFixture,
  isError,
  located,
  MAIL,
  mdx,
  QUOTA,
  readFile,
  writeFile,
} from "./helpers.ts";

/** Error diagnostics of a one-module project whose design has the given blocks. */
function errorsOf(t: TestContext, ...blocks: string[]) {
  const root = designProject(t, { m: mdx(...blocks) });
  return { root, errors: designErrors(root).map(located), here: (code: string, needle: string, offset = 0) => ({ code, ...at(root, "m", needle, offset) }) };
}

test("the plan fixture is indexed: contracts, data, invariants and declared dependencies", () => {
  const { index, diagnostics } = checkDesigns(path.join(fixturesDir, "vertical"));

  assert.deepEqual(
    index.contracts.map(({ name, module, shape, description, members }) => ({ name, module, shape, description, members: members.map((member) => [member.name, member.description]) })),
    [
      {
        name: "Send",
        module: "src/modules/campaigns",
        shape: "object",
        description: "Виконує одну спробу відправлення за наявності квоти.",
        members: [["run", "Отримує квоту та передає повідомлення відправнику."]],
      },
      {
        name: "Sender",
        module: "src/modules/mail",
        shape: "object",
        description: "Порт передачі текстового повідомлення обраному транспорту.",
        members: [["send", null]],
      },
      {
        name: "Quota",
        module: "src/modules/quota",
        shape: "object",
        description: "Обліковує доступні спроби окремо для кожного акаунта.",
        members: [["take", "Намагається використати одну одиницю доступної квоти."]],
      },
    ],
  );
  assert.deepEqual(
    index.data.map(({ name, module, description, location }) => ({ name, module, description, location })),
    [{ name: "AccountId", module: "src/modules/quota", description: "Ідентифікатор акаунта для обліку квоти.", location: inFixture(QUOTA, "AccountId = string") }],
  );
  assert.deepEqual(
    index.invariants.map(({ contract, id, member }) => `${contract}: ${id} @ ${member}`),
    [
      "Send: quota @ run",
      "Send: limit @ run",
      "Send: quota-error @ run",
      "Send: sender-error @ run",
      "Quota: accounts @ null",
      "Quota: empty @ take",
      "Quota: consume @ take",
      "Quota: race @ take",
    ],
  );
  assert.deepEqual(index.invariants[0], {
    contract: "Send",
    id: "quota",
    text: "Викликає Sender лише після завершення Quota.take з true.",
    member: "run",
    location: inFixture(CAMPAIGNS, "@invariant quota "),
  });
  assert.deepEqual(
    index.edges.map((edge) => (edge.kind === "uses" ? `${edge.from} uses ${edge.to}` : `${edge.fromModule} imports types of ${edge.toModule}`)),
    ["src/modules/campaigns imports types of src/modules/quota", "Send uses Quota", "Send uses Sender"],
  );

  assert.deepEqual(diagnostics, [
    {
      code: "W_NO_INVARIANTS",
      severity: "warning",
      message: 'Contract "Sender" has no `@invariant`: only its types can be checked.',
      ...inFixture(MAIL, "Sender {"),
      contract: "Sender",
    },
  ]);
});

test("a contract is an interface with methods, or with one call signature", (t) => {
  const callable = [
    "/**",
    " * @contract",
    " * @description Нормалізує пробіли в заголовку.",
    " * @invariant spaces Прибирає крайові пробіли та стискає внутрішні до одного.",
    " */",
    "export interface CleanTitle {",
    "  /** @invariant idempotent Повторне застосування нічого не змінює. */",
    "  (input: string): string;",
    "}",
  ].join("\n");
  const root = designProject(t, { m: mdx(callable, contract("Store", "get(key: string): Promise<string | null>;\n  put(key: string, value: string): Promise<void>;")) });

  const { index, diagnostics } = checkDesigns(root);
  assert.deepEqual(diagnostics.filter(isError), []);
  assert.deepEqual(
    index.contracts.map(({ name, shape, members }) => [name, shape, members.map((member) => member.name)]),
    [
      ["CleanTitle", "callable", []],
      ["Store", "object", ["get", "put"]],
    ],
  );
  // A call signature has no name: its invariants are those of the contract.
  assert.deepEqual(
    index.invariants.map(({ id, member }) => [id, member]),
    [
      ["spaces", null],
      ["idempotent", null],
    ],
  );
});

test("unsupported contract shapes are rejected, each where it is declared", (t) => {
  const cases: [body: string, needle: string][] = [
    ["get?(key: string): string;", "get?("],
    ["size: number;", "size: number"],
    ["read: (key: string) => string;", "read: ("],
    ["[key: string]: unknown;", "[key: string]"],
    ['"quoted-name"(): void;', '"quoted-name"'],
    ["new (key: string): object;", "new (key"],
    ["get<T>(key: string): T;", "T>(key"],
    ["get(key: string): string;\n  get(key: number): string;", "get(key: number)"],
    ["(a: string): string;\n  (a: number): string;", "(a: number)"],
    ["(a: string): string;\n  run(): void;", "(a: string)"],
  ];
  for (const [body, needle] of cases) {
    const { errors, here } = errorsOf(t, contract("Shape", body));
    assert.deepEqual(errors, [here("E_UNSUPPORTED_DECLARATION", needle)], body);
  }

  const header = (declaration: string) => contract("Shape").replace("export interface Shape {", declaration);
  assert.deepEqual(errorsOf(t, header("export interface Shape<T> {")).errors.map((error) => error.code), ["E_UNSUPPORTED_DECLARATION"]);
  assert.deepEqual(errorsOf(t, data("Base", "{ a: string }").replace("type Base =", "interface Base"), header("export interface Shape extends Base {")).errors.map((error) => error.code), [
    "E_UNSUPPORTED_DECLARATION",
  ]);
  const empty = errorsOf(t, contract("Shape", ""));
  assert.deepEqual(empty.errors, [empty.here("E_UNSUPPORTED_DECLARATION", "interface Shape", "interface ".length)]);
  const alias = errorsOf(t, contract("Shape").replace(/export interface Shape \{[^}]*\}/, "export type Shape = { run(): void };"));
  assert.deepEqual(alias.errors, [alias.here("E_UNSUPPORTED_DECLARATION", "type Shape", "type ".length)]);
});

test("data types are free-form: generics, unions and extends are allowed", (t) => {
  const blocks = [
    data("Id"),
    data("Page<T>", "{ items: T[]; next: Id | null }"),
    ["/**", " * @data", " * @description Base.", " */", "export interface Base {", "  /** Plain field docs are fine. @see Page */", "  id: Id;", "}"].join("\n"),
    ["/**", " * @data", " * @description Derived.", " */", "export interface Derived extends Base {", "  [key: string]: unknown;", "}"].join("\n"),
    contract("Reader", "read(id: Id): Promise<Page<Derived>>;"),
  ];
  const root = designProject(t, { m: mdx(...blocks) });
  const { index, diagnostics } = checkDesigns(root);
  assert.deepEqual(diagnostics.filter(isError), []);
  assert.deepEqual(index.data.map((type) => type.name), ["Id", "Page", "Base", "Derived"]);
});

test("a design block declares only types: everything else is rejected", (t) => {
  const cases: [code: string, statement: string][] = [
    ["E_UNSUPPORTED_DECLARATION", "export class Service {}"],
    ["E_UNSUPPORTED_DECLARATION", "export function run(): void {}"],
    ["E_UNSUPPORTED_DECLARATION", "export const limit = 1;"],
    ["E_UNSUPPORTED_DECLARATION", "export enum Mode { A }"],
    ["E_UNSUPPORTED_DECLARATION", "export declare const flag: boolean;"],
    ["E_UNSUPPORTED_DECLARATION", "export namespace Inner { export type A = string }"],
    ["E_UNSUPPORTED_DECLARATION", "export type { Thing as Renamed };"],
    ["E_UNSUPPORTED_DECLARATION", "export default Thing;"],
    ["E_DESIGN_IMPORT", 'import "./side-effect.ts";'],
    ["E_DESIGN_IMPORT", 'import { Helper } from "./helper.ts";'],
    ["E_DESIGN_IMPORT", 'import { type Helper } from "./helper.ts";'],
    // Every statement that names another module is an import: the compiler is never sent after it.
    ["E_DESIGN_IMPORT", 'export * from "../missing.ts";'],
    ["E_DESIGN_IMPORT", 'export type { Helper } from "./helper.ts";'],
    ["E_DESIGN_IMPORT", 'import type fs = require("node:fs");'],
  ];
  for (const [code, statement] of cases) {
    const { errors, here } = errorsOf(t, `${statement}\n\n${contract("Thing")}`);
    assert.deepEqual(errors, [here(code, statement)], statement);
  }

  const hidden = errorsOf(t, contract("Thing"), data("Helper").replace("export type", "type"));
  assert.deepEqual(hidden.errors, [hidden.here("E_UNSUPPORTED_DECLARATION", "type Helper", "type ".length)]);

  const inline = errorsOf(t, contract("Thing", 'run(): import("node:fs").Stats;'));
  assert.deepEqual(inline.errors, [inline.here("E_DESIGN_IMPORT", 'import("node:fs")')]);
});

test("every declaration has exactly one marker, and a description", (t) => {
  const plain = "export interface Plain {\n  run(): void;\n}";
  const unmarked = errorsOf(t, contract("Thing"), plain, `/** Documented, but not marked. */\n${plain.replace("Plain", "Documented")}`);
  assert.deepEqual(unmarked.errors, [
    unmarked.here("E_UNSUPPORTED_DECLARATION", "interface Plain", "interface ".length),
    unmarked.here("E_UNSUPPORTED_DECLARATION", "interface Documented", "interface ".length),
  ]);

  // A forgotten marker is one mistake: the tags that would be fine on a contract are not reported on top of it.
  const forgotten = errorsOf(t, contract("Other"), contract("Thing", "run(): void;", "@uses Other", "@invariant ok Працює.").replace(" * @contract\n", ""));
  assert.deepEqual(forgotten.errors, [forgotten.here("E_UNSUPPORTED_DECLARATION", "interface Thing", "interface ".length)]);

  const both = errorsOf(t, contract("Thing", "run(): void;", "@data"));
  assert.deepEqual(both.errors, [both.here("E_TAG_FORMAT", "@data")]);

  const named = errorsOf(t, contract("Thing").replace("@contract", "@contract Store"));
  assert.deepEqual(named.errors, [named.here("E_TAG_FORMAT", "@contract Store")]);

  const missing = errorsOf(t, contract("Thing").replace(" * @description Thing.\n", ""), data("Id").replace(" * @description Id.\n", ""));
  assert.deepEqual(missing.errors, [
    missing.here("E_DESCRIPTION_MISSING", "interface Thing", "interface ".length),
    missing.here("E_DESCRIPTION_MISSING", "type Id", "type ".length),
  ]);

  const empty = errorsOf(t, contract("Thing").replace("@description Thing.", "@description"), data("Id").replace("@description Id.", "@description   "));
  assert.deepEqual(empty.errors, [empty.here("E_TAG_FORMAT", "@description"), { ...empty.here("E_TAG_FORMAT", "@description   ") }]);

  const twice = errorsOf(t, contract("Thing", "run(): void;", "@description Again."));
  assert.deepEqual(twice.errors, [twice.here("E_TAG_FORMAT", "@description Again.")]);

  // On a method the description is optional, but not empty.
  const method = errorsOf(t, contract("Thing", "/** @description */\n  run(): void;\n  /** No tags. */\n  stop(): void;"));
  assert.deepEqual(method.errors, [method.here("E_TAG_FORMAT", "@description */")]);
});

test("invariants need an id and a text, and ids are unique in a contract", (t) => {
  const format = errorsOf(
    t,
    contract("Thing", "run(): void;", "@invariant", "@invariant lonely", "@invariant Upper Текст.", "@invariant ok Правильний."),
  );
  assert.deepEqual(format.errors, [
    format.here("E_TAG_FORMAT", "@invariant"),
    format.here("E_TAG_FORMAT", "@invariant lonely"),
    format.here("E_TAG_FORMAT", "@invariant Upper"),
  ]);

  const root = designProject(t, {
    m: mdx(
      contract("First", "/**\n   * @invariant shared На методі.\n   * @invariant own Багаторядковий\n   *   текст інваріанта.\n   */\n  run(): void;", "@invariant shared На контракті."),
      contract("Second", "run(): void;", "@invariant shared Той самий id в іншому контракті."),
    ),
  });
  const { index, diagnostics } = checkDesigns(root);
  const duplicate = at(root, "m", "@invariant shared На методі.");
  assert.deepEqual(diagnostics, [
    {
      code: "E_INVARIANT_DUPLICATE",
      severity: "error",
      message: 'Invariant id "shared" is already used in contract "First".',
      ...duplicate,
      contract: "First",
      invariant: "shared",
      related: [{ message: "The other invariant.", ...at(root, "m", "@invariant shared На контракті.") }],
    },
  ]);
  assert.deepEqual(
    index.invariants.map(({ contract, id, member, text }) => [contract, id, member, text]),
    [
      ["First", "shared", null, "На контракті."],
      ["First", "own", "run", "Багаторядковий текст інваріанта."],
      ["Second", "shared", null, "Той самий id в іншому контракті."],
    ],
  );
  assert.deepEqual(index.invariants[1].location, at(root, "m", "@invariant own"));
});

test("tags are read only from the doc comment right before a declaration", (t) => {
  const blocks = [
    [
      "// @contract in a line comment is not a tag",
      "/* @invariant x Nor in a plain block comment. */",
      "/**",
      " * @contract",
      " * @description Thing: mail team@example.com, or mention @invariant mid-sentence.",
      " * @param nothing Standard tags are left alone.",
      " * @see Other",
      " */",
      "export interface Thing {",
      '  run(mode: "@invariant fake Текст у рядку"): void;',
      "}",
    ].join("\n"),
  ];
  const clean = designProject(t, { m: mdx(...blocks) });
  const { index, diagnostics } = checkDesigns(clean);
  assert.deepEqual(diagnostics.filter(isError), []);
  assert.deepEqual(index.invariants, []);

  const misplaced = errorsOf(
    t,
    [
      "/** @invariant early Перед іншим коментарем. */",
      "// this comment separates the doc comment from the declaration",
      contract("Thing", "/** @contract */\n  run(): void;\n  /** @invariant dangling Після останнього методу. */", "@implements Other", "@covers a"),
    ].join("\n"),
    [
      "/**",
      " * @data",
      " * @description Row.",
      " * @uses Thing",
      " * @invariant row На типі даних.",
      " */",
      "export interface Row {",
      "  /** @description На полі. */",
      "  id: string;",
      "}",
    ].join("\n"),
  );
  assert.deepEqual(misplaced.errors, [
    misplaced.here("E_TAG_LOCATION", "@invariant early"),
    misplaced.here("E_TAG_LOCATION", "@implements Other"),
    misplaced.here("E_TAG_LOCATION", "@covers a"),
    misplaced.here("E_TAG_LOCATION", "@contract */"),
    misplaced.here("E_TAG_LOCATION", "@invariant dangling"),
    misplaced.here("E_TAG_LOCATION", "@uses Thing"),
    misplaced.here("E_TAG_LOCATION", "@invariant row"),
    misplaced.here("E_TAG_LOCATION", "@description На полі."),
  ]);
});

test("a doc comment binds to the declaration directly after it, also on the same line", (t) => {
  const root = designProject(t, {
    m: mdx(["/** @data", " * @description Id. */ export type Id = string; /** @contract", " * @description Thing. */ export interface Thing { /** @invariant ok Працює. */ run(): void; }"].join("\n")),
  });
  const { index, diagnostics } = checkDesigns(root);
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(index.data.map((type) => type.name), ["Id"]);
  assert.deepEqual(index.invariants.map(({ contract, id, member }) => [contract, id, member]), [["Thing", "ok", "run"]]);
});

test("a doc comment that ends the line of one member does not document the next member", (t) => {
  const { errors, here } = errorsOf(t, contract("Thing", "run(): void; /** @invariant late Про run, але після нього. */\n  stop(): void;", "@invariant ok Працює."));
  assert.deepEqual(errors, [here("E_TAG_LOCATION", "@invariant late")]);
});

test("a doc comment after the last declaration of the document is still checked", (t) => {
  const { errors, here } = errorsOf(t, contract("Thing"), `${data("Id")}\n\n/**\n * @invariant dangling Після всього.\n * @bogus\n */`);
  assert.deepEqual(errors, [here("E_TAG_LOCATION", "@invariant dangling"), here("E_UNKNOWN_TAG", "@bogus")]);
});

test("a tag with punctuation after its name is a malformed tag, not prose", (t) => {
  const block = ["/**", " * @contract", " * @description: Thing.", " * @invariant: race Текст.", " * @uses, Other", " */", "export interface Thing {", "  run(): void;", "}"].join("\n");
  const { errors, here } = errorsOf(t, block, contract("Other", "run(): void;", "@invariant ok Працює."));
  assert.deepEqual(errors, [
    here("E_TAG_FORMAT", "@description: Thing."),
    here("E_TAG_FORMAT", "@invariant: race"),
    here("E_TAG_FORMAT", "@uses, Other"),
    here("E_DESCRIPTION_MISSING", "interface Thing", "interface ".length),
  ]);

  const marker = errorsOf(t, contract("Thing").replace("@contract", "@contract."));
  assert.deepEqual(marker.errors, [marker.here("E_TAG_FORMAT", "@contract."), marker.here("E_UNSUPPORTED_DECLARATION", "interface Thing", "interface ".length)]);
});

test("one mistake is one diagnostic", (t) => {
  // The tags on an unsupported member are not reported on top of the member itself.
  const member = errorsOf(t, contract("Thing", "/** @description Розмір. */\n  size: number;\n  run(): void;"));
  assert.deepEqual(member.errors, [member.here("E_UNSUPPORTED_DECLARATION", "size: number")]);

  // Two contracts of one name keep their own invariants: only the name is a duplicate.
  const twice = errorsOf(t, contract("Store", "run(): void;", "@invariant ok Перший."), contract("Store", "stop(): void;", "@invariant ok Другий."));
  assert.deepEqual(twice.errors.map((error) => error.code), ["E_CONTRACT_DUPLICATE"]);

  // A rejected declaration is reported once; the tags on its members are where they belong.
  const members = "/** @invariant a Перший. */\n  run(): void;\n  /** @invariant b Другий. */\n  stop(): void;";
  const both = errorsOf(t, contract("Thing", members, "@data"));
  assert.deepEqual(both.errors, [both.here("E_TAG_FORMAT", "@data")]);
  const unmarked = errorsOf(t, contract("Thing"), `export interface Plain {\n  ${members}\n}`);
  assert.deepEqual(unmarked.errors, [unmarked.here("E_UNSUPPORTED_DECLARATION", "interface Plain", "interface ".length)]);
  const alias = errorsOf(t, contract("Other"), contract("Thing", members).replace("export interface Thing {", "export type Thing = {"));
  assert.deepEqual(alias.errors, [alias.here("E_UNSUPPORTED_DECLARATION", "type Thing", "type ".length)]);
  const merged = errorsOf(t, data("Thing", "{ a: string }").replace("type Thing =", "interface Thing"), contract("Thing", members));
  const second = readFile(merged.root, designFile("m")).split("\n").indexOf("export interface Thing {") + 1;
  assert.deepEqual(merged.errors, [{ code: "E_UNSUPPORTED_DECLARATION", file: designFile("m"), line: second, column: "export interface ".length + 1 }]);

  // Invariants that were written but rejected are not also reported as missing.
  const rejected = checkDesigns(designProject(t, { m: mdx(contract("Thing", "run(): void;", "@invariant Upper Текст.")) }));
  assert.deepEqual(rejected.diagnostics.map((diagnostic) => diagnostic.code), ["E_TAG_FORMAT"]);
});

test("unknown and postponed tags are errors in design doc comments", (t) => {
  const { errors, here } = errorsOf(
    t,
    contract("Thing", "/** @todo later */\n  run(): void;", "@Contract", "@name Store", "@Final", "@internal"),
    `/** @open */\n${data("Id")}`,
  );
  assert.deepEqual(errors, [
    here("E_UNKNOWN_TAG", "@Contract"),
    here("E_UNSUPPORTED_TAG", "@name Store"),
    here("E_UNKNOWN_TAG", "@Final"),
    here("E_UNKNOWN_TAG", "@internal"),
    here("E_UNKNOWN_TAG", "@todo later"),
    here("E_UNSUPPORTED_TAG", "@open"),
  ]);
});

test("a doc comment at the end of one block does not document the next block", (t) => {
  const { errors, here } = errorsOf(t, `${contract("Thing")}\n\n/**\n * @contract\n * @description Other.\n */`, "export interface Other {\n  run(): void;\n}");
  const description = here("E_TAG_LOCATION", "@description Other.");
  assert.deepEqual(errors, [
    { ...description, line: description.line - 1 },
    description,
    here("E_UNSUPPORTED_DECLARATION", "interface Other", "interface ".length),
  ]);
});

test("comments that hide type errors are not allowed in design blocks", (t) => {
  const { errors, here } = errorsOf(
    t,
    `// Leading comment.\n// @ts-nocheck\n${data("Bad", "NotThere")}`,
    contract("Thing", "// @ts-ignore\n  run(): Missing;\n  /* @ts-expect-error */\n  stop(): Missing;"),
  );
  // The compiler honours all three, so it reports none of the three unknown names.
  assert.deepEqual(errors, [
    here("E_UNSUPPORTED_DECLARATION", "@ts-nocheck"),
    here("E_UNSUPPORTED_DECLARATION", "@ts-ignore"),
    here("E_UNSUPPORTED_DECLARATION", "@ts-expect-error"),
  ]);

  // Any mention in a comment is rejected, whether this version of the compiler honours the spelling or not:
  // where it does, the rejection is the only diagnostic left.
  const spellings = ["// @TS-IGNORE", "// @ts-ignoreX", "// @ts-ignore-next", "/*/ @ts-ignore */", `//${String.fromCharCode(0xa0)}@ts-ignore`, "/** @ts-ignoreX */", "// see @ts-expect-error: reason"];
  for (const comment of spellings) {
    const found = errorsOf(t, contract("Thing", `${comment}\n  run(): Missing;`));
    assert.deepEqual(found.errors.filter((error) => error.code !== "E_TYPESCRIPT"), [found.here("E_UNSUPPORTED_DECLARATION", comment, comment.indexOf("@"))], comment);
  }
  const first = errorsOf(t, `// @TS-NOCHECK\n${contract("Thing", "run(): Missing;")}`);
  assert.deepEqual(first.errors, [first.here("E_UNSUPPORTED_DECLARATION", "@TS-NOCHECK")]);
});

test("triple-slash references cannot bring files or packages into a design", (t) => {
  const root = designProject(t, {
    m: mdx(`/// <reference types="node" />\n/// <reference path="../impl.ts" />\n/// <reference lib="dom" />\n${data("Bytes", "Buffer")}`, contract("Thing")),
  });
  writeFile(root, "src/m/impl.ts", "declare global { type FromImpl = string }\nexport {};\n");
  assert.deepEqual(designErrors(root).map(located), [
    { code: "E_DESIGN_IMPORT", ...at(root, "m", '/// <reference types="node"') },
    { code: "E_DESIGN_IMPORT", ...at(root, "m", '/// <reference path="../impl.ts"') },
    { code: "E_DESIGN_IMPORT", ...at(root, "m", '/// <reference lib="dom"') },
  ]);

  // Taking the default library away is a mistake of the block, not of the project's tsconfig.
  const bare = errorsOf(t, contract("Thing"), `/// <reference no-default-lib="true"/>\n${data("Id")}`);
  assert.deepEqual(bare.errors, [bare.here("E_DESIGN_IMPORT", "/// <reference no-default-lib")]);
});

test("contract names are unique in the whole scope; data names only within a module", (t) => {
  const root = designProject(t, {
    a: mdx(contract("Store"), data("Row")),
    b: mdx(
      contract("Store"),
      data("Row"),
      data("Row", "{ a: string }").replace("type Row =", "interface Row"),
      data("Row", "{ b: string }").replace("type Row =", "interface Row"),
      contract("Mixed"),
      data("Mixed", "{ c: string }").replace("type Mixed =", "interface Mixed"),
    ),
  });
  const errors = designErrors(root);
  const merged = at(root, "b", "interface Row { b", "interface ".length);
  assert.deepEqual(errors.filter((error) => error.code !== "E_TYPESCRIPT"), [
    {
      code: "E_CONTRACT_DUPLICATE",
      severity: "error",
      message: 'Contract name "Store" is already used; contract names are unique in the whole scope.',
      ...at(root, "b", "interface Store", "interface ".length),
      contract: "Store",
      related: [{ message: "The other declaration.", ...at(root, "a", "interface Store", "interface ".length) }],
    },
    { code: "E_UNSUPPORTED_DECLARATION", severity: "error", message: '"Row" is declared more than once; declaration merging is not supported.', ...merged },
    {
      code: "E_UNSUPPORTED_DECLARATION",
      severity: "error",
      message: '"Mixed" is declared more than once; declaration merging is not supported.',
      ...at(root, "b", "interface Mixed { c", "interface ".length),
    },
  ]);
  // The type alias and the interfaces named Row in one module are the compiler's to report.
  assert.ok(errors.some((error) => error.code === "E_TYPESCRIPT" && error.tsCode === 2300));
});

test("@uses names contracts of the scope", (t) => {
  const root = designProject(t, {
    a: mdx(contract("Send", "run(): void;", "@uses Quota, Sender Quota", "@uses Helper"), contract("Helper")),
    b: mdx(contract("Quota"), contract("Sender")),
  });
  const { index, diagnostics } = checkDesigns(root);
  assert.deepEqual(diagnostics.filter(isError), []);
  assert.deepEqual(
    index.edges.map((edge) => (edge.kind === "uses" ? [edge.from, edge.to, edge.fromModule, edge.toModule] : [])),
    [
      ["Send", "Quota", "src/a", "src/b"],
      ["Send", "Sender", "src/a", "src/b"],
      ["Send", "Helper", "src/a", "src/a"],
    ],
  );

  // A name given again, in the same tag or a later one, is one dependency; names are TypeScript identifiers.
  const repeated = designProject(t, { a: mdx(contract("Надсилач"), contract("Send", "run(): void;", "@uses Надсилач Надсилач", "@uses Надсилач")) });
  const again = checkDesigns(repeated);
  assert.deepEqual(again.diagnostics.filter(isError), []);
  assert.deepEqual(again.index.edges.map((edge) => (edge.kind === "uses" ? [edge.from, edge.to] : [])), [["Send", "Надсилач"]]);

  const broken = designProject(t, { a: mdx(contract("Send", "run(): void;", "@uses Missing Send", "@uses", "@uses not-a-name"), data("Row"), contract("Other", "run(): void;", "@uses Row")) });
  assert.deepEqual(designErrors(broken).map(({ code, message, ...rest }) => ({ code, message, line: rest.line, column: rest.column })), [
    { code: "E_REFERENCE_UNKNOWN", message: "`@uses Missing`: there is no contract with this name.", ...position(broken, "@uses Missing Send") },
    { code: "E_REFERENCE_UNKNOWN", message: "`@uses Send`: a contract cannot use itself.", ...position(broken, "@uses Missing Send") },
    { code: "E_TAG_FORMAT", message: "`@uses` needs one or more contract names.", line: position(broken, "@uses Missing Send").line + 1, column: 4 },
    { code: "E_TAG_FORMAT", message: "`@uses` needs one or more contract names.", ...position(broken, "@uses not-a-name") },
    { code: "E_REFERENCE_UNKNOWN", message: "`@uses Row`: there is no contract with this name.", ...position(broken, "@uses Row") },
  ]);
});

const position = (root: string, needle: string) => {
  const { line, column } = at(root, "a", needle);
  return { line, column };
};

const importing = (module: string, names: string) => `import type { ${names} } from "../${module}/${module}.cage.mdx";`;

test("a design imports only types of other designs of the scope", (t) => {
  const root = designProject(t, {
    a: mdx(data("Id"), data("Name")),
    // Two imports from one design are one dependency.
    b: mdx(`${importing("a", "Id")}\n${importing("a", "Name")}\n\n${contract("Reader", "read(id: Id): Name;")}`),
  });
  const { index, diagnostics } = checkDesigns(root);
  assert.deepEqual(diagnostics.filter(isError), []);
  assert.deepEqual(index.edges, [{ kind: "type-import", fromModule: "src/b", toModule: "src/a", location: at(root, "b", "import type") }]);

  writeFile(root, "src/b/helper.ts", "export type Helper = string;\n");
  writeFile(root, "src/b/notes.mdx", "# Notes\n");
  // A design document outside the scope (the default patterns look under src/).
  writeFile(root, "elsewhere/outside.cage.mdx", "# Поза scope\n\n```ts design\nexport type Gone = string;\n```\n");
  const imports = [
    'import type { Helper } from "../helper.ts";',
    'import type { Stats } from "node:fs";',
    'import type Notes from "../notes.mdx";',
    'import type { Reader } from "./b.cage.mdx";',
    'import type { Gone } from "../../elsewhere/outside.cage.mdx";',
    'import type { Never } from "../nowhere/nowhere.cage.mdx";',
    'import type { Bare } from "../a/.cage/design.ts";',
  ];
  editFile(root, designFile("b"), (s) => s.replace(importing("a", "Name"), `${importing("a", "Name")}\n${imports.join("\n")}`));
  const found = designErrors(root).map(located);
  const here = (code: string, needle: string) => ({ code, ...at(root, "b", needle) });
  // Reported at the module specifier. The compiler is not asked: it would repeat these as unresolved modules,
  // or read the types of a design document that happens to be outside the scope.
  assert.deepEqual(found, [
    here("E_DESIGN_IMPORT", '"../helper.ts"'),
    here("E_DESIGN_IMPORT", '"node:fs"'),
    here("E_DESIGN_IMPORT", '"../notes.mdx"'),
    here("E_DESIGN_IMPORT", '"./b.cage.mdx"'),
    here("E_DESIGN_OUT_OF_SCOPE", '"../../elsewhere/outside.cage.mdx"'),
    here("E_DESIGN_OUT_OF_SCOPE", '"../nowhere/nowhere.cage.mdx"'),
    // The virtual file is the compiler's business, not the author's.
    here("E_DESIGN_IMPORT", '"../a/.cage/design.ts"'),
  ]);
});

test("imports of components in the MDX itself are not design dependencies and are not executed", (t) => {
  const document = ['import { Chart } from "./chart.js"', "", "export const meta = { a: 1 }", "", "# Module", "", "<Chart data={meta} />", "", "Prose.", "", "```ts design", contract("Thing"), "```", ""].join("\n");
  const root = designProject(t, { a: document });
  const { index, diagnostics } = checkDesigns(root);
  assert.deepEqual(diagnostics.filter(isError), []);
  assert.deepEqual(index.edges, []);
});

test("modules that depend on each other in a cycle are an error with the path", (t) => {
  const root = designProject(t, {
    a: mdx(`${importing("b", "B")}\n\n${data("A", "B | string")}`, contract("First", "run(): void;", "@uses Second")),
    b: mdx(data("B"), contract("Second", "run(): void;", "@uses Third")),
    c: mdx(contract("Third", "run(): void;", "@uses First"), contract("Inner", "run(): void;", "@uses Third")),
    d: mdx(contract("Leaf", "run(): void;", "@uses First")),
  });
  assert.deepEqual(designErrors(root), [
    {
      code: "E_DESIGN_CYCLE",
      severity: "error",
      message: "Design modules depend on each other in a cycle: src/a → src/b → src/c → src/a.",
      ...at(root, "a", "import type"),
      related: [
        { message: "src/b depends on src/c here.", ...at(root, "b", "@uses Third") },
        { message: "src/c depends on src/a here.", ...at(root, "c", "@uses First") },
      ],
    },
  ]);

  // Dependencies inside one module, in both directions, are not a cycle between modules.
  const inner = designProject(t, { a: mdx(contract("One", "run(): void;", "@uses Two"), contract("Two", "run(): void;", "@uses One")) });
  assert.deepEqual(designErrors(inner), []);
});

test("a scope needs a contract; a module may hold only data", (t) => {
  const dataOnly = designProject(t, { a: mdx(data("Id")) });
  assert.deepEqual(designErrors(dataOnly).map(located), [{ code: "E_NO_CONTRACTS", file: undefined, line: undefined, column: undefined }]);

  const mixed = designProject(t, { a: mdx(data("Id")), b: mdx(contract("Thing")) });
  assert.deepEqual(designErrors(mixed), []);
});

test("a document without prose, or a contract without invariants, is a warning", (t) => {
  const block = ["```ts design", contract("Thing", "run(): void;", "@invariant ok Працює."), "```"].join("\n");
  const warnings = (document: string) =>
    checkDesigns(designProject(t, { a: document }))
      .diagnostics.map(({ code, severity, file, line }) => ({ code, severity, file, line }));
  const missing = [{ code: "W_BUSINESS_CONTEXT_MISSING", severity: "warning", file: designFile("a"), line: undefined }];

  assert.deepEqual(warnings(block), missing);
  assert.deepEqual(warnings(`# Title\n\n## Only headings\n\n${block}\n\n\`\`\`ts\nconst example = 1;\n\`\`\`\n\n<Note />\n`), missing);
  assert.deepEqual(warnings(`# Title\n\nA sentence.\n\n${block}`), []);
  assert.deepEqual(warnings(`# Title\n\n${block}\n\n- a list item\n`), []);
  assert.deepEqual(warnings(`# Title\n\n| Rule | Result |\n| --- | --- |\n| empty | false |\n\n${block}`), []);
});

