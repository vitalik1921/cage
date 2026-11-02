import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canDelete, CourseRemoval, EducationRemoval, pick } from "./removal.ts";
import type { Editor, Entry, Page } from "./removal.ts";

const entries = (...titles: string[]): Entry[] => titles.map(title => ({ title, text: title }));

/** @tests EntryPicker */
describe("entry selection", () => {
  /** @covers exact-title-wins */
  it("the exact title among lookalikes", () => {
    assert.deepEqual(pick(entries("QAV Analyst", "QAV Analyst 2"), "QAV Analyst"), { index: 0, mode: "title" });
    assert.deepEqual(pick(entries("QAV Analyst", "QAV AnalystQAV Analyst"), "QAV Analyst"), null);
    for (const title of ["  qAv   analyst ", "QAV AnalystQAV Analyst", "QAV Analyst QAV Analyst"]) {
      assert.deepEqual(pick(entries("other", title), "QAV Analyst"), { index: 1, mode: "title" });
    }
    assert.deepEqual(pick([{ title: "marker 9971", text: "marker 9971" }, { title: "Other", text: "marker 9971" }], "marker 9971"), { index: 0, mode: "title" });
  });
  /** @covers title-tie-refused */
  it("two equal titles", () => { assert.equal(pick(entries("QAV Analyst", "QAV Analyst"), "QAV Analyst"), null); });
  /** @covers lookalike-refused */
  it("a lookalike blocks a unique marker", () => {
    assert.equal(pick([{ title: "QAV Analyst 2", text: "QAV Analyst 2" }, { title: "Other", text: "QAV Analyst" }], "QAV Analyst"), null);
  });
  /** @covers single-marker */
  it("a marker in one description", () => {
    assert.deepEqual(pick([{ title: "Real Course", text: "note marker 9971 here" }], "marker 9971"), { index: 0, mode: "marker" });
    assert.equal(pick(entries("Other"), "marker 9971"), null);
  });
  /** @covers marker-tie-refused */
  it("two holders of a marker", () => {
    assert.equal(pick([{ title: "First", text: "marker 9971" }, { title: "Second", text: "marker 9971" }], "marker 9971"), null);
  });
  /** @covers unreadable-list */
  it("the list cannot be read", () => { assert.equal(pick(null, "marker 9971"), null); });
  /** @covers match-is-literal */
  it("brackets and pluses remain literal", () => {
    assert.deepEqual(pick(entries("QA C", "QA (C++)"), "QA (C++)"), { index: 1, mode: "title" });
    for (const match of ["QA (C++)", "a.b", "x[y]", "a*b", "a\\b", "a|b"]) {
      assert.deepEqual(pick([{ title: "Other", text: "note " + match }], match), { index: 0, mode: "marker" });
      for (const text of [match + "2", "Ж" + match, match + "é"]) assert.equal(pick([{ title: "Other", text }], match), null);
    }
  });
});

const editor = (values: Partial<Editor> = {}): Editor => ({ shown: true, inputs: [], textareas: [], text: "", ...values });
/** @tests EditorCheck */
describe("editor identity", () => {
  /** @covers editor-proves-identity */
  it("the editor proves the selected mode", () => {
    const title = { index: 0, mode: "title" as const };
    const marker = { index: 0, mode: "marker" as const };
    assert.equal(canDelete([editor({ inputs: ["QAV Analyst"] })], title, "QAV Analyst"), true);
    assert.equal(canDelete([editor({ inputs: ["QAV Analyst 2"] })], title, "QAV Analyst"), false);
    assert.equal(canDelete([editor({ inputs: ["QAV Analyst", "QAV Analyst 2"] })], title, "QAV Analyst"), false);
    assert.equal(canDelete([editor({ textareas: ["QAV Analyst"] })], title, "QAV Analyst"), false);
    assert.equal(canDelete([editor({ text: "note marker 9971" })], marker, "marker 9971"), true);
    assert.equal(canDelete([editor({ textareas: ["note marker 9971"] })], marker, "marker 9971"), true);
    assert.equal(canDelete([editor({ inputs: ["note marker 9971"] })], marker, "marker 9971"), true);
    assert.equal(canDelete([editor({ text: "marker 99712" })], marker, "marker 9971"), false);
    assert.equal(canDelete([], title, "QAV Analyst"), false);
    assert.equal(canDelete([editor({ shown: false, inputs: ["QAV Analyst"] })], title, "QAV Analyst"), false);
    assert.equal(canDelete([editor({ inputs: ["QAV Analyst"] }), editor({ inputs: ["QAV Analyst"] })], title, "QAV Analyst"), false);
  });
});

function recordingPage(): Page & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    read() { calls.push("read"); return entries("QAV Analyst"); },
    edit() { calls.push("edit"); return [editor({ inputs: ["QAV Analyst 2"] })]; },
    delete() { calls.push("delete"); },
    escape() { calls.push("escape"); },
  };
}

/** @tests RemoveCourses */
describe("courses", () => {
  /** @covers match-required */
  it("a two-letter match is refused", () => {
    for (const match of ["", " a ", " ab "]) {
      const page = recordingPage();
      assert.throws(() => new CourseRemoval().run(page, match), /three characters/);
      assert.deepEqual(page.calls, []);
    }
  });
});

/** @tests RemoveEducation */
describe("education", () => {
  /** @covers match-required */
  it("a two-letter match is refused", () => {
    for (const match of ["", " a ", " ab "]) {
      const page = recordingPage();
      assert.throws(() => new EducationRemoval().run(page, match), /three characters/);
      assert.deepEqual(page.calls, []);
    }
  });
});

it("an unproven editor closes without deletion", () => {
  const page = recordingPage();
  new CourseRemoval().run(page, "QAV Analyst");
  assert.deepEqual(page.calls, ["read", "edit", "escape"]);
});
