/** Packet-local references shorten metadata; source text and recorded evidence use full paths. */
export function reviewReferences(knownFiles: readonly string[] = []) {
  const files = new Map<string, string>();
  const known = new Set(knownFiles);
  const tests = new Map<string, { id: string; location: string; title: string }>();
  const file = (path: string): string => {
    known.add(path);
    if (!files.has(path)) files.set(path, `F${files.size + 1}`);
    return files.get(path)!;
  };
  const test = (value: { file: string; line: number; column: number; title: string }): string => {
    const key = JSON.stringify([value.file, value.line, value.column, value.title]);
    if (!tests.has(key)) tests.set(key, { id: `T${tests.size + 1}`, location: `${file(value.file)}:${value.line}:${value.column}`, title: value.title });
    return tests.get(key)!.id;
  };
  return {
    file,
    test,
    // Only references inside the evidence field are abbreviated, never invariant/reason text or code.
    evidence: (text: string): string => {
      if (known.size === 0) return text;
      const paths = [...known].filter(Boolean).sort((a, b) => b.length - a.length).map((path) => path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      const reference = new RegExp("(^|[\\s;,()\"'`])(" + paths.join("|") + ")(?=:\\d)", "g");
      return text.replace(reference, (_match, before: string, path: string) => before + file(path));
    },
    lines: (): string[] => files.size === 0 && tests.size === 0 ? [] : [
      "## References", "",
      "F/T/S references are local to this packet. Use full paths from this dictionary in verdict evidence; --record does not expand reference IDs.", "",
      ...[...files].map(([path, id]) => `${id} ${JSON.stringify(path)}`), "",
      ...[...tests.values()].map(({ id, location, title }) => `${id} ${location} ${JSON.stringify(title)}`),
      ...(tests.size > 0 ? [""] : []),
    ],
  };
}
