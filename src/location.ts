import path from "node:path";

export interface Position {
  line: number;
  column: number;
}

export interface Line {
  /** Line content without its line ending. */
  text: string;
  /** Offset of the line start. */
  start: number;
}

/** Offsets of line starts; CRLF, CR and LF each end one line. */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 13 && text.charCodeAt(i + 1) === 10) i++;
    if (code === 13 || code === 10) starts.push(i + 1);
  }
  return starts;
}

export function splitLines(text: string): Line[] {
  const starts = lineStarts(text);
  return starts.map((start, index) => {
    let end = text.length;
    if (index + 1 < starts.length) {
      end = starts[index + 1] - 1;
      if (end > start && text[end - 1] === "\r" && text[end] === "\n") end--;
    }
    return { text: text.slice(start, end), start };
  });
}

/** Index of the last item whose `startOf` value is <= `offset`; 0 if there is none. `items` is sorted. */
export function lastStartingAtOrBefore<T>(items: readonly T[], startOf: (item: T) => number, offset: number): number {
  let low = 0;
  let high = items.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (startOf(items[mid]) <= offset) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** 1-based line and column (in UTF-16 code units) of an offset. */
export function positionAt(starts: readonly number[], offset: number): Position {
  const index = lastStartingAtOrBefore(starts, (start) => start, offset);
  return { line: index + 1, column: offset - starts[index] + 1 };
}

export function toProjectPath(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

/** Drops a leading byte order mark, so offsets match what parsers and editors count. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
