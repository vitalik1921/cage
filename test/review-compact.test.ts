import assert from "node:assert/strict";
import { test } from "node:test";
import { reviewReferences } from "../src/review-references.ts";
import { formatReviewMarkdown, type ReviewReport } from "../src/review.ts";
import { cli, copyFixture, reviewFileId } from "./helpers.ts";

/** @tests Cli
 * @covers review-packet */
test("file references preserve unusual paths, evidence ranges, and unknown references", () => {
  const path = 'src/a space/[quoted] "file".ts';
  const refs = reviewReferences([path, "src/a.ts"]);
  assert.equal(refs.evidence(`checked (${path}:12-19), src/a.ts:7:3; outside/a.ts:9`), "checked (F1:12-19), F2:7:3; outside/a.ts:9");
  assert.equal(refs.evidence("archive/src/a.ts:7; src/a.ts.extra:2"), "archive/src/a.ts:7; src/a.ts.extra:2");
  assert.equal(refs.file(path), "F1");
  assert.ok(refs.lines().includes(`F1 ${JSON.stringify(path)}`));
  assert.ok(refs.lines().some((line) => line.includes("--record does not expand reference IDs")));
});

/** @tests Cli
 * @covers review-packet */
test("test identity includes file, line and column; repeated titles cannot merge distinct tests", () => {
  const refs = reviewReferences();
  const declaration = { file: "src/a.spec.ts", line: 10, column: 1, title: 'same "title"\nsecond line' };
  assert.equal(refs.test(declaration), "T1");
  assert.equal(refs.test({ ...declaration }), "T1");
  assert.equal(refs.test({ ...declaration, column: 20 }), "T2");
  assert.equal(refs.test({ ...declaration, line: 11 }), "T3");
  assert.equal(refs.test({ ...declaration, file: "src/b.spec.ts" }), "T4");
  assert.equal(refs.lines().filter((line) => /^T\d+ /.test(line)).length, 4);
  assert.equal(refs.lines().filter((line) => line === `T1 F1:10:1 ${JSON.stringify(declaration.title)}`).length, 1);
});

/** Decode only numbered source blocks; never expand references in source code. */
function sourceBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  let fence = "", lines: string[] = [];
  for (const line of markdown.split("\n")) {
    if (!fence && /^`{3,}(ts|mdx)$/.test(line)) { fence = /^`+/.exec(line)![0]; lines = []; }
    else if (fence && line === fence) { blocks.push(lines.join("\n")); fence = ""; }
    else if (fence) lines.push(line.replace(/^\s*\d+ \| /, ""));
  }
  return blocks;
}

/** @tests Cli
 * @covers review-packet */
test("compact Markdown preserves every source block and test link without mutating the JSON packet", (t) => {
  const root = copyFixture(t, "vertical");
  const report = JSON.parse(cli(root, "review", "Send", "Quota", "--format", "json").stdout) as ReviewReport;
  report.files[0].text += '\nF1:42 src/modules/campaigns/send.test.ts "T1" ```\n';
  const before = JSON.stringify(report);
  const markdown = formatReviewMarkdown(report);
  assert.equal(JSON.stringify(report), before);
  assert.deepEqual(sourceBlocks(markdown), report.files.map((file) => file.text.replace(/\n$/, "")));
  const tests = new Map([...markdown.matchAll(/^(T\d+) (F\d+):(\d+):(\d+) (".*")$/gm)].map((match) => [match[1], { file: match[2], line: Number(match[3]), column: Number(match[4]), title: JSON.parse(match[5]) }]));
  for (const packet of report.contracts) {
    const start = markdown.indexOf(`# ${packet.contract} (`);
    const end = markdown.indexOf("\n# ", start);
    const section = markdown.slice(start, end < 0 ? undefined : end);
    const lists = [...section.matchAll(/^  tests: (.*)$/gm)];
    assert.equal(lists.length, packet.invariants.length);
    for (const [index, invariant] of packet.invariants.entries()) {
      const ids = lists[index][1] === "none" ? [] : lists[index][1].split(", ");
      assert.deepEqual(ids.map((id) => tests.get(id)), invariant.tests.map((test) => ({ ...test, file: reviewFileId(markdown, test.file) })));
      assert.ok(section.includes(invariant.text));
    }
    assert.equal(markdown.split(packet.fingerprint).length - 1, 1);
    assert.ok(markdown.includes(`${packet.contract}: ${packet.fingerprint}`));
  }
  // The example's finding schema is printed once for the entire report.
  assert.equal(markdown.split('"suggestedChange":"<what to change, or null>"').length - 1, 1);
  assert.match(markdown, /Use full paths in evidence:/);
});
