import path from "node:path";
import { checkDesignPhase } from "./design-phase.ts";
import { compareDiagnostics, hasErrors, type Diagnostic } from "./diagnostic.ts";
import { checkImplementationPhase, testsLinkedTo, type GeneratedArtifact, type ImplementationPhaseOptions, type ImplementationPhaseResult } from "./implementation-phase.ts";
import { toProjectPath } from "./location.ts";
import { compareLocks, compareWithBase, readBaseLocks, readLockFile } from "./locks.ts";
import { readStrictOptions, type StrictOptions, type TypeScriptInfo } from "./typescript.ts";

export type Phase = "design" | "implementation";

/**
 * The report of `design check`. What was not looked at is `null` or
 * "not-checked", never 0 or "current": "not checked" is not "not found". The
 * design phase never looks at generated files, implementations and tests,
 * and the implementation phase does not get to them when a design has
 * errors; contracts are not counted when an error stopped the check before
 * the designs were indexed.
 *
 * A linked test declaration says that a test tagged with the invariant
 * exists. It does not say that the test ran, passed or checks the right thing.
 */
export interface CheckReport {
  schemaVersion: 1;
  command: "check";
  phase: Phase;
  ok: boolean;
  /** `lockBase`: the Git revision whose locks the lock file was compared with, or null when it was not. */
  scope: { tsconfig: string; designFiles: string[]; typescript: TypeScriptInfo; compilerOptions: StrictOptions | null; lockBase: string | null };
  generatedArtifacts: { source: string; file: string; status: "not-checked" | GeneratedArtifact["status"] }[];
  counts: {
    contracts: number | null;
    data: number | null;
    invariants: number | null;
    implementations: number | null;
    testDeclarations: number | null;
    linkedInvariants: number | null;
  };
  invariants: { contract: string; id: string; member: string | null; linkedTestCount: number | null }[] | null;
  diagnostics: Diagnostic[];
}

/**
 * `lockBase` is a Git revision: the lock file is then also compared with
 * the one recorded there, so that a lock cannot be lifted by editing the
 * file.
 */
export function runCheck(options: ImplementationPhaseOptions, phase: Phase, lockBase?: string): CheckReport {
  const root = path.resolve(options.root);
  const result: ImplementationPhaseResult = phase === "design" ? { ...checkDesignPhase(options), artifacts: null, linking: null } : checkImplementationPhase(options);
  const { modules, index, artifacts, linking, typescript, compiler, diagnostics } = result;
  // Locks are compared with designs that are sound: a rejected declaration would look like a lock that was lifted.
  const designsAreSound = index !== null && (phase === "design" ? !hasErrors(diagnostics) : artifacts !== null);
  const configured = (options.problems?.length ?? 0) === 0;
  if (configured && (designsAreSound || lockBase !== undefined)) {
    const lockFile = readLockFile(root);
    diagnostics.push(...lockFile.diagnostics);
    if (lockFile.diagnostics.length === 0 && designsAreSound) {
      const { violations, unrecorded } = compareLocks(index, lockFile.entries);
      diagnostics.push(...violations, ...unrecorded);
    }
    if (lockFile.diagnostics.length === 0 && lockBase !== undefined) {
      const base = readBaseLocks(root, lockBase);
      diagnostics.push(...base.diagnostics, ...compareWithBase(base.entries, lockFile.entries, lockBase));
    }
    diagnostics.sort(compareDiagnostics);
  }
  const linkedTestCount = (contract: string, id: string) => (linking ? testsLinkedTo(linking.tests, contract, id).length : null);
  const invariants = index?.invariants.map(({ contract, id, member }) => ({ contract, id, member, linkedTestCount: linkedTestCount(contract, id) })) ?? null;
  return {
    schemaVersion: 1,
    command: "check",
    phase,
    ok: !hasErrors(diagnostics),
    scope: {
      tsconfig: options.tsconfig,
      designFiles: options.designs.map((design) => toProjectPath(root, design.sourceFile)),
      typescript,
      compilerOptions: compiler ? readStrictOptions(compiler.ts, compiler.options) : null,
      lockBase: configured && lockBase !== undefined ? lockBase : null,
    },
    generatedArtifacts: artifacts ?? modules.map((module) => ({ source: module.file, file: module.generatedPath, status: "not-checked" })),
    counts: {
      contracts: index?.contracts.length ?? null,
      data: index?.data.length ?? null,
      invariants: index?.invariants.length ?? null,
      implementations: linking?.implementations.length ?? null,
      testDeclarations: linking?.tests.length ?? null,
      linkedInvariants: linking && invariants ? invariants.filter((invariant) => invariant.linkedTestCount !== 0).length : null,
    },
    invariants,
    diagnostics,
  };
}
