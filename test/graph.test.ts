import assert from "node:assert/strict";
import { test } from "node:test";
import type { Edge } from "../src/design-model.ts";
import { findModuleCycles } from "../src/graph.ts";

const location = { file: "design.mdx", line: 1, column: 1 };
const edge = (fromModule: string, toModule: string): Edge => ({ kind: "type-import", fromModule, toModule, location });
const paths = (edges: Edge[]) => findModuleCycles(edges).map((cycle) => cycle.map((step) => `${step.fromModule}>${step.toModule}`).join(" "));

test("no cycle: chains, diamonds and dependencies inside a module", () => {
  assert.deepEqual(paths([]), []);
  assert.deepEqual(paths([edge("a", "b"), edge("b", "c"), edge("a", "c"), edge("d", "c"), edge("a", "a")]), []);
});

test("each group of mutually dependent modules is reported once, by a shortest cycle", () => {
  assert.deepEqual(paths([edge("b", "a"), edge("a", "b")]), ["a>b b>a"]);
  // Two separate cycles, and a module that only leads into one of them.
  assert.deepEqual(paths([edge("z", "a"), edge("a", "b"), edge("b", "a"), edge("x", "y"), edge("y", "x")]), ["a>b b>a", "x>y y>x"]);
  // The long way round a>b>c>d>a exists, but a>c>a is shorter.
  assert.deepEqual(paths([edge("a", "b"), edge("b", "c"), edge("c", "d"), edge("d", "a"), edge("a", "c"), edge("c", "a")]), ["a>c c>a"]);
  // Two cycles that share a module are one group: every module in it depends on every other.
  assert.deepEqual(paths([edge("a", "b"), edge("b", "a"), edge("b", "c"), edge("c", "b")]), ["a>b b>a"]);
});

test("the first declared edge between two modules represents the dependency", () => {
  const first: Edge = { kind: "uses", from: "A", to: "B", fromModule: "a", toModule: "b", location: { ...location, line: 5 } };
  const cycles = findModuleCycles([first, edge("a", "b"), edge("b", "a")]);
  assert.equal(cycles[0][0], first);
});
