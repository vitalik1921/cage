import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test, type TestContext } from "node:test";
import type { GraphReport } from "../src/graph-command.ts";
import { cli, contract, data, designProject, editFile, mdx, snapshot } from "./helpers.ts";

const project = (t: TestContext) => designProject(t, {
  base: mdx(contract("Base", "run(): void;").replace("@contract", "@family"), data("Payload")),
  leaf: mdx(contract("Leaf")),
  worker: mdx('import type { Base } from "../base/base.cage.mdx";', contract("Worker", "", "@uses Leaf").replace("interface Worker {", "interface Worker extends Base {")),
  app: mdx('import type { Worker } from "../worker/worker.cage.mdx";', contract("App", "run(worker: Worker): void;", "@uses Worker")),
}, { "src/app/broken.ts": "this implementation is deliberately not valid TypeScript", ".cage/lock.json": "not JSON", ".cage/review.json": "not JSON" });
const graph = (root: string, ...args: string[]) => JSON.parse(cli(root, "graph", ...args, "--format", "json").stdout) as GraphReport;
const edges = (report: GraphReport) => report.edges!.map(edge => `${edge.kind}:${edge.from}->${edge.to}`).sort();

/** @tests Cli */
describe("design graph", () => {
  /** @covers graph-relations graph-output */
  test("the complete graph includes uses, family inheritance and module imports with declaration locations", t => {
    const root = project(t), before = snapshot(root);
    const report = graph(root);
    assert.equal(report.ok, true, JSON.stringify(report));
    assert.deepEqual(edges(report), [
      "extends:contract:Worker->contract:Base", "type-import:module:src/app->module:src/worker", "type-import:module:src/worker->module:src/base", "uses:contract:App->contract:Worker", "uses:contract:Worker->contract:Leaf",
    ]);
    assert.equal(report.nodes!.find(node => node.name === "Base")?.kind, "family");
    assert.ok(report.nodes!.some(node => node.kind === "data" && node.name === "Payload"));
    for (const edge of report.edges!) { assert.ok(edge.location.file.endsWith(".cage.mdx")); assert.ok(edge.location.line > 0 && edge.location.column > 0); }
    assert.deepEqual(snapshot(root), before);
  });

  /** @covers graph-traversal */
  test("depth bounds forward and used-by traversal; module imports do not invent contract uses", t => {
    const root = project(t);
    assert.deepEqual(edges(graph(root, "Worker", "--depth", "0")), []);
    assert.deepEqual(edges(graph(root, "Worker", "--depth", "1")), ["extends:contract:Worker->contract:Base", "type-import:module:src/worker->module:src/base", "uses:contract:Worker->contract:Leaf"]);
    assert.deepEqual(edges(graph(root, "--used-by", "Base", "--depth", "1")), ["extends:contract:Worker->contract:Base", "type-import:module:src/worker->module:src/base"]);
    assert.deepEqual(edges(graph(root, "Base", "--used-by", "--depth", "2")), ["extends:contract:Worker->contract:Base", "type-import:module:src/app->module:src/worker", "type-import:module:src/worker->module:src/base", "uses:contract:App->contract:Worker"]);
    assert.deepEqual(graph(root, "Base", "--used-by").edges, graph(root, "Base", "--used-by", "--depth", "2").edges);
    const leaf = graph(root, "Leaf", "--used-by", "--depth", "1");
    assert.deepEqual(edges(leaf), ["uses:contract:Worker->contract:Leaf"]);
    assert.ok(!leaf.nodes!.some(node => node.id === "contract:App"));
  });

  /** @covers graph-output */
  test("text, JSON and Mermaid render the same selected edges deterministically on TS5 and TS6", t => {
    let expected: unknown;
    for (const compiler of ["typescript-5", "typescript"]) {
      const root = project(t);
      fs.mkdirSync(path.join(root, "node_modules"));
      fs.symlinkSync(path.resolve("node_modules", compiler), path.join(root, "node_modules/typescript"), "dir");
      const report = graph(root, "App");
      const text = cli(root, "graph", "App").stdout;
      const mermaid = cli(root, "graph", "App", "--format", "mermaid").stdout;
      assert.equal(report.ok, true);
      assert.equal(mermaid, cli(root, "graph", "App", "--format", "mermaid").stdout);
      assert.equal(JSON.stringify(report), JSON.stringify(graph(root, "App")));
      assert.equal(text.split("\n").filter(line => / --(?:uses|extends|type-import)-->/u.test(line)).length, report.edges!.length);
      const ids = new Map(report.nodes!.map((node, index) => [node.id, `n${index}`]));
      assert.deepEqual(mermaid.split("\n").filter(line => line.includes(" -->|")), report.edges!.map(edge => `  ${ids.get(edge.from)} -->|${edge.kind}| ${ids.get(edge.to)}`));
      if (expected) assert.deepEqual(report, expected);
      expected = report;
    }
  });

  /** @covers graph-relations graph-output */
  test("a rejected design or unknown focus is reported without a misleading empty graph", t => {
    const root = project(t);
    const unknown = graph(root, "Missing");
    assert.equal(unknown.ok, false);
    assert.equal(unknown.nodes, null);
    assert.ok(unknown.diagnostics.some(item => item.code === "E_REFERENCE_UNKNOWN"));
    editFile(root, "src/worker/worker.cage.mdx", text => text.replace("@uses Leaf", "@uses Missing"));
    const rejected = graph(root);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.edges, null);
    assert.match(cli(root, "graph").stdout, /graph: not available/);
    assert.match(cli(root, "graph", "--format", "mermaid").stdout, /%% E_REFERENCE_UNKNOWN/);
  });

  /** @covers graph-traversal graph-output */
  test("graph arguments reject missing names, extra names, invalid depths and options of other commands", t => {
    const root = project(t);
    for (const args of [["graph", "--used-by"], ["graph", "--depth", "1"], ["graph", "App", "Leaf"], ["graph", "App", "--depth", "-1"], ["graph", "App", "--depth", "1.5"], ["graph", "App", "--depth", "Infinity"], ["graph", "App", "--format", "dot"], ["graph", "App", "--phase", "lint"], ["check", "--used-by"], ["check", "--depth", "1"]]) assert.equal(cli(root, ...args).code, 2, args.join(" "));
  });
});
