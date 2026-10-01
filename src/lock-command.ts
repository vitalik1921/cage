import fs from "node:fs";
import path from "node:path";
import type { LockLevel } from "./design-model.ts";
import { checkDesignPhase, type DesignPhaseOptions } from "./design-phase.ts";
import { hasErrors, type Diagnostic } from "./diagnostic.ts";
import { compareLocks, formatLockFile, LOCK_FILE, readLockFile, recordLocks } from "./locks.ts";
import { writeRecordFile } from "./record-file.ts";

export interface LockReport {
  schemaVersion: 1;
  command: "lock";
  ok: boolean;
  /** The lock file, relative to the project root. */
  file: string;
  locks: { module: string; name: string; kind: "contract" | "data"; level: LockLevel; status: "recorded" | "extended" | "unchanged" }[];
  diagnostics: Diagnostic[];
}

/**
 * Records the declarations marked `@final` or `@extendable` that the lock
 * file does not have yet, and the additions to extendable ones. It never
 * changes what is already recorded, and records nothing while the designs
 * have any other error.
 */
export function runLock(options: DesignPhaseOptions): LockReport {
  const root = path.resolve(options.root);
  const { index, diagnostics } = checkDesignPhase(options);
  const report = (locks: LockReport["locks"]): LockReport => ({ schemaVersion: 1, command: "lock", ok: !hasErrors(diagnostics), file: LOCK_FILE, locks, diagnostics });
  if (hasErrors(diagnostics) || !index) return report([]);

  const lockFile = readLockFile(root);
  // What is not recorded yet is what this command is for; a broken lock is not something it may overwrite.
  diagnostics.push(...lockFile.diagnostics, ...(lockFile.diagnostics.length > 0 ? [] : compareLocks(index, lockFile.entries).violations));
  if (hasErrors(diagnostics)) return report([]);

  const { entries, recorded } = recordLocks(index, lockFile.entries);
  if (recorded.some(({ status }) => status !== "unchanged")) {
    try {
      writeRecordFile(path.join(root, LOCK_FILE), formatLockFile(entries));
    } catch (cause) {
      diagnostics.push({ code: "E_ENVIRONMENT", severity: "error", message: `Cannot write the lock file: ${(cause as Error).message}`, file: LOCK_FILE });
      return report([]);
    }
  }
  return report(recorded.map(({ declaration: { module, name, kind, level }, status }) => ({ module, name, kind, level, status })));
}
