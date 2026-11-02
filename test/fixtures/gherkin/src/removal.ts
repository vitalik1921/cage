export interface Entry { title: string; text: string }
export interface Picked { index: number; mode: "title" | "marker" }
export interface Editor { shown: boolean; inputs: readonly string[]; textareas: readonly string[]; text: string }
export interface Page {
  read(): readonly Entry[] | null;
  edit(index: number): readonly Editor[];
  delete(index: number): void;
  escape(): void;
}

const normalize = (text: string): string => text.trim().replace(/\s+/gu, " ").toLowerCase();
const equal = (text: string, match: string): boolean => {
  const value = normalize(text);
  return value === match || value === match + match || value === match + " " + match;
};
const phrase = (text: string, match: string): boolean => {
  const escaped = match.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp("(?<![\\p{L}\\p{N}])" + escaped + "(?![\\p{L}\\p{N}])", "u").test(normalize(text));
};

/** @implements EntryPicker */
export function pick(entries: readonly Entry[] | null, match: string): Picked | null {
  const needle = normalize(match);
  if (!entries || !needle) return null;
  const titles = entries.flatMap((entry, index) => equal(entry.title, needle) ? [index] : []);
  if (titles.length > 0) return titles.length === 1 ? { index: titles[0], mode: "title" } : null;
  if (entries.some(entry => phrase(entry.title, needle))) return null;
  const markers = entries.flatMap((entry, index) => phrase(entry.text, needle) ? [index] : []);
  return markers.length === 1 ? { index: markers[0], mode: "marker" } : null;
}

/** @implements EditorCheck */
export function canDelete(editors: readonly Editor[], target: Picked, match: string): boolean {
  const shown = editors.filter(editor => editor.shown);
  if (shown.length !== 1) return false;
  const editor = shown[0];
  const needle = normalize(match);
  if (target.mode === "title") {
    return editor.inputs.some(value => equal(value, needle)) && !editor.inputs.some(value => !equal(value, needle) && phrase(value, needle));
  }
  return [editor.text, ...editor.inputs, ...editor.textareas].some(value => phrase(value, needle));
}

function remove(page: Page, match: string): void {
  if (match.trim().length < 3) throw new Error("match needs three characters");
  const target = pick(page.read(), match);
  if (!target) return;
  if (canDelete(page.edit(target.index), target, match)) page.delete(target.index);
  else page.escape();
}

/** @implements RemoveCourses */
export class CourseRemoval {
  run(page: Page, match: string): void { remove(page, match); }
}

/** @implements RemoveEducation */
export class EducationRemoval {
  run(page: Page, match: string): void { remove(page, match); }
}
