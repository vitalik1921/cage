import { compareText } from "./diagnostic.ts";
import type { ChangedPart, ReviewIndexEntry } from "./review.ts";

export interface ReviewGroup {
  contracts: string[];
  /** Argument vector, to run from the project root without parsing a shell string. */
  command: string[];
  /** Same changed part/file, not necessarily the same selected lines or review baseline. */
  sharedChanges: { change: ChangedPart; contracts: string[] }[];
  additionalChanges: { contract: string; changed: ChangedPart[] }[];
}

type Entry = Pick<ReviewIndexEntry, "contract" | "status" | "changed">;
const changeKey = (change: ChangedPart) => JSON.stringify([change.kind, change.file, change.part, change.change]);

/** Connected shared changes make one packet; every contract needing review occurs exactly once. */
export function groupReviews(entries: readonly Entry[]): ReviewGroup[] {
  const needed = entries.filter(({ status }) => status === "outdated" || status === "none" || status === "unknown")
    .sort((a, b) => compareText(a.contract, b.contract));
  const causes = new Map<string, { change: ChangedPart; contracts: Set<string> }>();
  const keys = new Map<string, string[]>();
  for (const entry of needed) {
    const own: string[] = [];
    for (const change of entry.status === "outdated" ? entry.changed : []) {
      // Every declaration is called "contract" in its own record; it is never shared.
      if (change.kind === "contract") continue;
      const key = changeKey(change);
      const cause = causes.get(key) ?? { change, contracts: new Set<string>() };
      cause.contracts.add(entry.contract);
      causes.set(key, cause);
      own.push(key);
    }
    keys.set(entry.contract, own);
  }
  const byName = new Map(needed.map((entry) => [entry.contract, entry]));
  const visited = new Set<string>();
  const groups: ReviewGroup[] = [];
  for (const entry of needed) {
    if (visited.has(entry.contract)) continue;
    const contracts = [entry.contract];
    visited.add(entry.contract);
    const shared = new Set<string>();
    for (let index = 0; index < contracts.length; index++) {
      for (const key of keys.get(contracts[index]) ?? []) {
        const cause = causes.get(key)!;
        if (cause.contracts.size < 2 || shared.has(key)) continue;
        shared.add(key);
        for (const name of cause.contracts) {
          if (visited.has(name)) continue;
          visited.add(name);
          contracts.push(name);
        }
      }
    }
    contracts.sort(compareText);
    groups.push({
      contracts,
      command: ["cage", "review", ...contracts],
      sharedChanges: [...shared].sort(compareText).map((key) => {
        const cause = causes.get(key)!;
        return { change: cause.change, contracts: [...cause.contracts].sort(compareText) };
      }),
      additionalChanges: contracts.flatMap((contract) => {
        const changed = byName.get(contract)!.changed.filter((change) => change.kind === "contract" || !shared.has(changeKey(change)));
        return changed.length > 0 ? [{ contract, changed }] : [];
      }),
    });
  }
  return groups;
}

/** Quote identifiers such as `$Sender` so a pasted command cannot expand shell variables. */
export function reviewCommand(command: readonly string[]): string {
  return command.map((arg) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`).join(" ");
}
