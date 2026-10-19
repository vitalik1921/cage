import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { CheckReport } from "../src/check.ts";
import { type Diagnostic, isError } from "../src/diagnostic.ts";
import { formatCheckReport, groupDiagnostics, limitCheckReport } from "../src/report.ts";
import { cli, cliWithStdin, contract, data, designProject, inFile, mdx, writeFile } from "./helpers.ts";

const COMPILERS = ["typescript-5", "typescript"] as const;

/** @tests Cli
 * @covers diagnostic-groups diagnostic-line */
test("a clipped summary that hides the actual type difference leaves the full diagnostics separate", (t) => {
  for (const compiler of COMPILERS) {
    const fields = Array.from({ length: 25 }, (_, i) => `commonProperty${i}: string;`).join(" ");
    const root = designProject(t, {
      api: mdx(data("Shape", `{ ${fields} tail: string; }`), contract("First", "read(): Shape;"), contract("Second", "read(): Shape;")),
    }, {
      "src/api/impl.ts": `type Shape = { ${fields} readonly tail: string; };\n/** @implements First */\nexport class First { read(): Shape { return {} as Shape; } }\n/** @implements Second */\nexport class Second { read(): Shape { return {} as Shape; } }`,
    });
    fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
    fs.symlinkSync(path.resolve("node_modules", compiler), path.join(root, "node_modules/typescript"), "dir");
    const diagnostics = json(root, "--max-diagnostics", "all").diagnostics.filter(d => d.code === "E_CONTRACT_SIGNATURE");
    assert.equal(diagnostics.length, 2, compiler);
    assert.ok(diagnostics.every(d => d.cause === undefined), compiler);
    const text = cli(root, "check", "--max-diagnostics", "all");
    assert.equal(text.code, 1);
    assert.equal(text.stdout.split("\n").filter(line => line.startsWith("E_CONTRACT_SIGNATURE:")).length, 2);
  }
});

const DRIVER = "src/browser/driver.ts", TAB = "src/other/tab.ts", BANDS = "src/bands/bands.ts", USER = "src/schema/user.ts", PLAIN = "src/plain/plain.ts";

/**
 * Repeated surface errors, one implementation per contract:
 * - Driver takes the module's own Page where Browser's methods take the design's PageHandle (= unknown), three times;
 *   `mixed` also returns another type, so its mismatch is two pairs;
 * - TabImpl does the same against another module's PageHandle, spelled the same and declared apart;
 * - widen and narrow take their file's Band where Widen and Narrow take the design's Band, spelled the same;
 * - User inherits three public members from one class of an installed package, and declares one extra itself;
 * - unrelated contracts with the same naked mismatch, a primitive (string against "x") or an anonymous tuple
 *   ([number, number] against readonly [number, number]), which share no declaration.
 */
function project(t: TestContext, compiler: (typeof COMPILERS)[number], config?: object): string {
  const root = designProject(t, {
    browser: mdx(data("PageHandle", "unknown"), contract("Browser", "open(page: PageHandle): void;\n  close(page: PageHandle): void;\n  title(page: PageHandle): string;\n  mixed(page: PageHandle): string;")),
    other: mdx(data("PageHandle", "unknown"), contract("Tab", "open(page: PageHandle): void;")),
    bands: mdx(data("Band", "[number, number]"), contract("Widen", "(band: Band): number;"), contract("Narrow", "(band: Band): number;")),
    schema: mdx(contract("UserSchema", "run(): void;")),
    plain: mdx(contract("Labeler", "label(): string;"), contract("Titler", "title(): string;"), contract("PairA", "(pair: [number, number]): void;"), contract("PairB", "(pair: [number, number]): void;")),
  }, {
    [DRIVER]: [
      "interface Page { url: string }",
      "/** @implements Browser */",
      "export class Driver {",
      "  open(page: Page): void {}",
      "  close(page: Page): void {}",
      "  title(page: Page): string { return page.url; }",
      '  mixed(page: Page): "x" { return "x"; }',
      "}",
      "",
    ].join("\n"),
    [TAB]: "interface Page { url: string }\n/** @implements Tab */\nexport class TabImpl {\n  open(page: Page): void {}\n}\n",
    [BANDS]: [
      "type Band = readonly [min: number, max: number];",
      "/** @implements Widen */",
      "export function widen(band: Band): number { return band[0]; }",
      "/** @implements Narrow */",
      "export function narrow(band: Band): number { return band[1]; }",
      "",
    ].join("\n"),
    "node_modules/schema-lib/package.json": JSON.stringify({ name: "schema-lib", version: "1.0.0", types: "index.d.ts" }),
    "node_modules/schema-lib/index.d.ts": "export declare class Schema<T> {\n  parse(input: unknown): T;\n  safeParse(input: unknown): { ok: boolean };\n  describe(text: string): this;\n}\n",
    [PLAIN]: [
      '/** @implements Labeler */\nexport class Labels {\n  label(): "x" { return "x"; }\n}',
      '/** @implements Titler */\nexport class Titles {\n  title(): "x" { return "x"; }\n}',
      "/** @implements PairA */\nexport function pairA(pair: readonly [number, number]): void {}",
      "/** @implements PairB */\nexport function pairB(pair: readonly [number, number]): void {}",
      "",
    ].join("\n"),
    [USER]: 'import { Schema } from "schema-lib";\n/** @implements UserSchema */\nexport class User extends Schema<string> {\n  run(): void {}\n  helper(): void {}\n}\n',
  });
  if (config) writeFile(root, ".cage/config.json", JSON.stringify({ version: 1, ...config }));
  fs.symlinkSync(path.resolve("node_modules", compiler), path.join(root, "node_modules/typescript"), "dir");
  return root;
}

const json = (root: string, ...args: string[]): CheckReport => JSON.parse(cli(root, "check", "--format", "json", ...args).stdout);

const PAGE = "signatures differ from their contracts in one type: expected PageHandle = unknown, actual Page";
const BAND = "signatures differ from their contracts in one type: expected Band = [number, number], actual Band = readonly [min: number, max: number]";
const SCHEMA = "public members declared by class Schema are absent from the affected contracts";

/** The surface diagnostics expected here, by code, first line, subject, contract and place, each computed from the files. */
function expectedSurface(root: string) {
  const at = (file: string, needle: string) => inFile(root, file, needle);
  const call = (name: string, contract: string, file: string) => ({ code: "E_CONTRACT_SIGNATURE", head: `${name}: call signature differs from ${contract}; parameter count, optional/rest markers and types must match`, subject: name, contract, ...at(file, name) });
  const method = (owner: string, name: string, contract: string, file: string) => ({ code: "E_CONTRACT_SIGNATURE", head: `${owner}.${name}: signature differs from ${contract}`, subject: `${owner}.${name}`, contract, ...at(file, `${name}(`) });
  return [
    call("widen", "Widen", BANDS),
    call("narrow", "Narrow", BANDS),
    ...["open", "close", "title", "mixed"].map((name) => method("Driver", name, "Browser", DRIVER)),
    method("TabImpl", "open", "Tab", TAB),
    method("Labels", "label", "Labeler", PLAIN),
    method("Titles", "title", "Titler", PLAIN),
    call("pairA", "PairA", PLAIN),
    call("pairB", "PairB", PLAIN),
    // Inherited members are reported on the tagged class; the member declared there, on itself.
    ...["parse", "safeParse", "describe"].map((name) => ({ code: "E_CONTRACT_EXTRA_MEMBER", head: `User.${name}: public member is absent from UserSchema`, subject: `User.${name}`, contract: "UserSchema", ...at(USER, "User extends") })),
    { code: "E_CONTRACT_EXTRA_MEMBER", head: "User.helper: public member is absent from UserSchema", subject: "User.helper", contract: "UserSchema", ...at(USER, "helper") },
  ];
}

const surfaceOf = (report: CheckReport) => report.diagnostics.filter((d) => d.code.startsWith("E_CONTRACT_"));
const placeOf = ({ file, line, column }: { file?: string; line?: number; column?: number }) => `${file}:${line}:${column}`;
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** @tests Cli
 * @covers diagnostic-groups diagnostic-line exact-signatures */
test("check prints repeated surface errors with one proven cause once, lists every affected diagnostic, and keeps each in JSON on TS5/TS6", (t) => {
  const ids: string[][] = [];
  for (const compiler of COMPILERS) {
    const root = project(t, compiler);
    const full = json(root, "--max-diagnostics", "all");
    assert.equal(full.scope.typescript.version, compiler === "typescript-5" ? "5.9.3" : "6.0.3");
    const surface = surfaceOf(full);
    const expected = expectedSurface(root);
    // Every underlying diagnostic stays, with its severity, place and full message.
    assert.deepEqual(surface.map(({ code, severity, message, file, line, column, contract }) => ({ code, severity, head: message.split("\n")[0], file, line, column, contract })), expected.map(({ subject, ...e }) => ({ ...e, severity: "error" })), compiler);
    assert.ok(surface.filter((d) => /^\w+\.\w+: signature differs/.test(d.message)).every((d) => /\nexpected: .*\nactual: /.test(d.message)), compiler);

    const cause = (head: string) => surface.find((d) => d.message.startsWith(head))?.cause;
    const page = cause("Driver.open"), band = cause("widen"), inherited = cause("User.parse");
    assert.ok(page && band && inherited, compiler);
    // The producer names each subject and its contracts; the shared part is the same for every one.
    assert.deepEqual(surface.filter((d) => d.cause).map((d) => [d.cause!.subject, d.cause!.contracts]), expected.filter((e) => cause(e.head)).map((e) => [e.subject, [e.contract]]), compiler);
    const shared = (c: Diagnostic["cause"]) => c && { id: c.id, summary: c.summary };
    assert.deepEqual([shared(cause("Driver.close")), shared(cause("Driver.title"))], [shared(page), shared(page)], compiler);
    assert.deepEqual(shared(cause("narrow")), shared(band), compiler);
    assert.deepEqual([shared(cause("User.safeParse")), shared(cause("User.describe"))], [shared(inherited), shared(inherited)], compiler);
    // An alias reveals what it stands for; two aliases named alike show their resolved difference.
    assert.equal(page.summary, PAGE);
    assert.equal(band.summary, BAND);
    assert.equal(inherited.summary, SCHEMA);
    // Two mismatched pairs, or a member of the tagged class itself, establish no common cause.
    assert.equal(cause("Driver.mixed"), undefined, compiler);
    assert.equal(cause("User.helper"), undefined, compiler);
    // A naked primitive or anonymous tuple mismatch shares no declaration: no cause, however alike.
    for (const head of ["Labels.label", "Titles.title", "pairA", "pairB"]) assert.equal(cause(head), undefined, `${compiler} ${head}`);
    // The same spelling declared in another module is another cause, although its summary reads the same.
    const tab = cause("TabImpl.open");
    assert.ok(tab && tab.id !== page.id && tab.summary === page.summary, compiler);
    ids.push(surface.map((d) => d.cause?.id ?? ""));

    const check = cli(root, "check", "--max-diagnostics", "all");
    assert.equal(check.code, 1);
    const text = check.stdout;
    const row = (index: number) => {
      const e = expected[index];
      return `  ${e.subject} (${placeOf(e)}) → ${e.contract} (${placeOf(full.diagnostics.find((d) => d.message.startsWith(e.head))!.related![0])})`;
    };
    // The code and the shared explanation once, then each affected subject with its contract, at their places.
    const block = (summary: string, rows: number[]) => [`E_CONTRACT_${summary === SCHEMA ? "EXTRA_MEMBER" : "SIGNATURE"}: ${summary} — ${rows.length} diagnostics:`, ...rows.map(row)].join("\n");
    assert.ok(text.includes(`${block(BAND, [0, 1])}\n`), text);
    assert.ok(text.includes(`${block(PAGE, [2, 3, 4])}\n`), text);
    assert.ok(text.includes(`${block(SCHEMA, [11, 12, 13])}\n`), text);
    assert.doesNotMatch(text, /^  \S+ .*(signature differs|public member is absent)/m);
    // What has no cause, or a cause of its own, is printed as before.
    for (const index of [5, 6, 7, 8, 9, 10, 14]) assert.match(text, new RegExp(`^${expected[index].code}: ${escape(expected[index].head)} \\(${placeOf(expected[index])}\\)\\n  `, "m"), `${compiler} ${index}`);
    assert.match(text, /^E_CONTRACT_SIGNATURE: TabImpl\.open: signature differs from Tab \(src\/other\/tab\.ts:4:3\)\n  expected: open: \(page: unknown\) => void\n  actual: open: \(page: Page\) => void$/m);
    assert.equal((text.match(/ diagnostics:$/gm) ?? []).length, 3);
    assert.match(text, /; 15 errors, 18 warnings\. TypeScript/);
  }
  // Ids are deterministic: the same on both compilers, and on a second run.
  assert.deepEqual(ids[0], ids[1]);
  assert.deepEqual(surfaceOf(json(project(t, "typescript"), "--max-diagnostics", "all")).map((d) => d.cause?.id ?? ""), ids[1]);
});

/** What a reader needs first, decided here on its own: unusable, failing, blocking the gate, the rest. */
const rank = (d: Diagnostic) => (d.code === "E_CONFIG" || d.code === "E_ENVIRONMENT" ? 0 : isError(d) ? 1 : /REVIEW_(MISSING|STALE)$/.test(d.code) ? 2 : 3);

/** Groups computed here from the JSON: same code, severity and cause id; ranked and limited as units. */
function expectedText(all: Diagnostic[], limit: number) {
  const groups: Diagnostic[][] = [];
  for (const d of all) {
    const group = d.cause && groups.find((g) => g[0].cause?.id === d.cause!.id && g[0].code === d.code && g[0].severity === d.severity);
    if (group) group.push(d);
    else groups.push([d]);
  }
  const ordered = groups.map((group, index) => ({ group, index })).sort((a, b) => rank(a.group[0]) - rank(b.group[0]) || a.index - b.index);
  const left = ordered.slice(limit).flatMap(({ group }) => group);
  const byCode = new Map<string, number>();
  for (const { code } of left) byCode.set(code, (byCode.get(code) ?? 0) + 1);
  return { shown: ordered.slice(0, limit).sort((a, b) => a.index - b.index).map(({ group }) => group), left, byCode };
}

/** @tests Cli
 * @covers diagnostic-groups check-limit diagnostic-line */
test("maxDiagnostics bounds the groups check prints and counts every diagnostic left out, while JSON keeps the raw limit", (t) => {
  for (const compiler of COMPILERS) {
    const root = project(t, compiler);
    const all = json(root, "--max-diagnostics", "all").diagnostics;
    assert.equal(all.length, 33);
    for (const limit of [0, 1, 3, 9, 50]) {
      const { shown, left, byCode } = expectedText(all, limit);
      const result = cli(root, "check", "--max-diagnostics", String(limit));
      assert.equal(result.code, 1, `${compiler} ${limit}`);
      const lines = result.stdout.trimEnd().split("\n");
      const heads = lines.filter((line) => /^[EW]_[A-Z_]+: /.test(line));
      // One head line per shown group: the group's cause, or the single diagnostic itself, in the report's order.
      assert.deepEqual(heads.map((line) => line.split(":")[0]), shown.map((group) => group[0].code), `${compiler} ${limit}`);
      assert.deepEqual(heads.map((line) => / diagnostics:$/.test(line)), shown.map((group) => group.length > 1), `${compiler} ${limit}`);
      for (const group of shown.filter((g) => g.length > 1)) {
        for (const d of group) assert.ok(lines.includes(`  ${d.cause!.subject} (${placeOf(d)}) → ${d.contract} (${placeOf(d.related![0])})`), `${compiler} ${limit} ${d.message}`);
      }
      const counts = [...byCode].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1)).map(([code, count]) => `${count} ${code}`).join(", ");
      assert.equal(lines.includes(`${left.length} more not shown (${counts}); --max-diagnostics all shows every one`), left.length > 0, `${compiler} ${limit}`);
      assert.match(lines.at(-1)!, /; 15 errors, 18 warnings\. TypeScript/);

      // JSON keeps the limit on single diagnostics.
      const limited = json(root, "--max-diagnostics", String(limit));
      assert.equal(limited.diagnostics.length, Math.min(limit, 33), `${compiler} ${limit}`);
      assert.equal(limited.omitted.count, 33 - Math.min(limit, 33), `${compiler} ${limit}`);
      assert.equal(limited.ok, false);
    }
    // Three groups hold six errors here: bands, the page methods and `mixed`.
    assert.match(cli(root, "check", "--max-diagnostics", "3").stdout, /^27 more not shown \(9 W_NO_INVARIANTS, 9 W_REVIEW_MISSING, 5 E_CONTRACT_SIGNATURE, 4 E_CONTRACT_EXTRA_MEMBER\); --max-diagnostics all shows every one$/m);

    // The limit is explicit: a serialized copy of the whole report formats as the report does, and a report already
    // limited by single diagnostics keeps its own omitted counts.
    const whole = json(root, "--max-diagnostics", "all");
    const copy: CheckReport = JSON.parse(JSON.stringify(whole));
    assert.equal(formatCheckReport(copy, 3), cli(root, "check", "--max-diagnostics", "3").stdout);
    const raw = limitCheckReport(whole, 3);
    const text = formatCheckReport(raw);
    assert.match(text, /^30 more not shown \(/m);
    assert.match(text, /; 15 errors, 18 warnings\. TypeScript/);
    assert.equal(formatCheckReport(JSON.parse(JSON.stringify(raw))), text);
  }
});

function session(t: TestContext): string {
  const id = `test-${crypto.randomBytes(6).toString("hex")}`;
  t.after(() => {
    for (const name of fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(`cage-gate-${id}-`))) fs.rmSync(path.join(os.tmpdir(), name), { force: true });
  });
  return id;
}

/** @tests Cli
 * @covers diagnostic-groups gate check-limit */
test("the gate still blocks on grouped errors, bounds groups, counts every blocker, and keeps review blockers apart", (t) => {
  for (const compiler of COMPILERS) {
    const root = project(t, compiler, { review: "require" });
    const id = session(t);
    const blocked = cliWithStdin(root, JSON.stringify({ session_id: id }), "gate");
    assert.equal(blocked.code, 2, compiler);
    // The heading counts diagnostics, not groups.
    assert.match(blocked.stderr, /^cage gate: blocked — 9 missing reviews, 15 other errors\n/, compiler);
    assert.match(blocked.stderr, new RegExp(`^E_CONTRACT_SIGNATURE: ${escape(PAGE)} — 3 diagnostics:$`, "m"));
    assert.match(blocked.stderr, new RegExp(`^E_CONTRACT_EXTRA_MEMBER: ${escape(SCHEMA)} — 3 diagnostics:$`, "m"));
    // Review blockers have no cause: each keeps its compact block and command.
    for (const name of ["Browser", "Tab", "Widen", "Narrow", "UserSchema", "Labeler", "Titler", "PairA", "PairB"]) {
      assert.match(blocked.stderr, new RegExp(`^E_REVIEW_MISSING: ${name} \\(src/[a-z]+/[a-z]+\\.cage\\.mdx:\\d+:\\d+\\)\\n  No recorded review\\. Review the contract:\\n    cage review ${name}$`, "m"), compiler);
    }
    assert.equal((blocked.stderr.match(/ diagnostics:$/gm) ?? []).length, 3);

    const all = json(root, "--max-diagnostics", "all").diagnostics.filter(isError);
    const { shown, left, byCode } = expectedText(all, 2);
    const limited = cliWithStdin(root, JSON.stringify({ session_id: id }), "gate", "--max-diagnostics", "2");
    assert.equal(limited.code, 2);
    assert.match(limited.stderr, /^cage gate: blocked — 9 missing reviews, 15 other errors\n/);
    assert.equal(limited.stderr.split("\n").filter((line) => /^E_[A-Z_]+: /.test(line)).length, 2);
    const counts = [...byCode].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1)).map(([code, count]) => `${count} ${code}`).join(", ");
    assert.ok(limited.stderr.includes(`\n${left.length} more not shown (${counts}); --max-diagnostics all shows every one\n`), limited.stderr);
    // Every blocker is either shown or counted.
    assert.equal(all.length, 24);
    assert.equal(shown.flat().length + left.length, 24);
  }
});

test("only diagnostics of one code and severity with the same cause id are grouped; equal text alone never is", () => {
  const base = { severity: "error" as const, message: "X.a: signature differs from C" };
  const cause = { id: "type:d1>d2", summary: "s", subject: "X.a", contracts: ["C"] };
  const diagnostics: Diagnostic[] = [
    { ...base, code: "E_CONTRACT_SIGNATURE", file: "a.ts", line: 1, column: 1, cause },
    { ...base, code: "E_CONTRACT_SIGNATURE", file: "a.ts", line: 2, column: 1 },
    { ...base, code: "E_CONTRACT_SIGNATURE", file: "a.ts", line: 3, column: 1 },
    { ...base, code: "E_CONTRACT_EXTRA_MEMBER", file: "a.ts", line: 4, column: 1, cause },
    { ...base, code: "E_CONTRACT_SIGNATURE", severity: "warning", file: "a.ts", line: 5, column: 1, cause },
    { ...base, code: "E_CONTRACT_SIGNATURE", file: "a.ts", line: 6, column: 1, cause: { ...cause, id: "type:d1>d3" } },
    { ...base, code: "E_CONTRACT_SIGNATURE", file: "b.ts", line: 7, column: 1, cause },
  ];
  assert.deepEqual(groupDiagnostics(diagnostics).map((group) => group.map((d) => d.line)), [[1, 7], [2], [3], [4], [5], [6]]);
});

/** @tests Cli
 * @covers diagnostic-groups exact-surface */
test("inherited static members without a static contract retain the missing-surface explanation", (t) => {
  const root = designProject(t, { api: mdx(contract("Worker", "run(): void;")) }, {
    "src/api/worker.ts": "class Base { static one(): void {} static two(): void {} }\n/** @implements Worker */\nexport class Worker extends Base { run(): void {} }\n",
  });
  const diagnostics = json(root, "--max-diagnostics", "all").diagnostics.filter(d => d.code === "E_CONTRACT_EXTRA_MEMBER");
  assert.equal(diagnostics.length, 2);
  assert.ok(diagnostics.every(d => d.cause === undefined));
  const result = cli(root, "check", "--max-diagnostics", "all");
  assert.equal(result.code, 1);
  assert.equal(result.stdout.split("\n").filter(line => line.startsWith("E_CONTRACT_EXTRA_MEMBER:")).length, 2);
  assert.match(result.stdout, /Worker static.one: public member is absent from the static contracts/);
  assert.match(result.stdout, /Worker static.two: public member is absent from the static contracts/);
});
