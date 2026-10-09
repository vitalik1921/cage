import assert from "node:assert/strict";
import { test } from "node:test";
import { groupReviews, reviewCommand } from "../src/review-groups.ts";
import type { ChangedPart, ReviewIndexEntry } from "../src/review.ts";

const dependency = (file: string, change: ChangedPart["change"] = "changed"): ChangedPart => ({ part: `dependency ${file}`, kind: "dependency", file, change });
const entry = (contract: string, changed: ChangedPart[], status: ReviewIndexEntry["status"] = "outdated") => ({ contract, status, changed });

/** @tests Cli
 * @covers review-index */
test("overlapping shared changes yield one command per connected group and preserve private changes", () => {
  const x = dependency("x.ts"), y = dependency("y.ts"), own = dependency("own.ts");
  const entries = [entry("A", [x, own]), entry("B", [x, y]), entry("C", [y]), entry("D", [dependency("other.ts")])];
  const groups = groupReviews(entries);
  assert.deepEqual(groups.map(({ contracts, command }) => ({ contracts, command })), [
    { contracts: ["A", "B", "C"], command: ["cage", "review", "A", "B", "C"] },
    { contracts: ["D"], command: ["cage", "review", "D"] },
  ]);
  assert.deepEqual(groups[0].sharedChanges, [{ change: x, contracts: ["A", "B"] }, { change: y, contracts: ["B", "C"] }]);
  assert.deepEqual(groups[0].additionalChanges, [{ contract: "A", changed: [own] }]);
  assert.deepEqual(groupReviews(entries.toReversed()), groups);
});

/** @tests Cli
 * @covers review-index */
test("same-file declarations and different changes do not imply a shared review cause", () => {
  const declaration: ChangedPart = { part: "contract", kind: "contract", file: "design.cage.mdx", change: "changed" };
  const groups = groupReviews([
    entry("A", [declaration, dependency("config.ts", "new")]),
    entry("B", [declaration, dependency("config.ts", "gone")]),
    entry("C", [{ part: "implementation code.ts#first", kind: "implementation", file: "code.ts", change: "changed" }]),
    entry("D", [{ part: "implementation code.ts#second", kind: "implementation", file: "code.ts", change: "changed" }]),
  ]);
  assert.deepEqual(groups.map(({ contracts }) => contracts), [["A"], ["B"], ["C"], ["D"]]);
  assert.ok(groups.every(({ sharedChanges }) => sharedChanges.length === 0));
  assert.deepEqual(groups[0].additionalChanges[0].changed[0], declaration);
});

/** @tests Cli
 * @covers review-index */
test("missing and unknown reviews stay separate; accepted/current reviews get no command", () => {
  const shared = dependency("config.ts");
  const groups = groupReviews([
    entry("Current", [shared], "current"), entry("Accepted", [shared], "accepted"),
    entry("Missing", [], "none"), entry("Unknown", [], "unknown"), entry("Outdated", []),
  ]);
  assert.deepEqual(groups.map(({ contracts }) => contracts), [["Missing"], ["Outdated"], ["Unknown"]]);
  assert.ok(groups.every(({ sharedChanges }) => sharedChanges.length === 0));
  assert.equal(reviewCommand(["cage", "review", "$Sender", "Quota"]), "cage review '$Sender' Quota");
});
