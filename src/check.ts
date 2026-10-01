import path from "node:path";
import { checkDesignPhase } from "./design-phase.ts";
import type { Edge, LockLevel, SourceLocation } from "./design-model.ts";
import { compareDiagnostics, hasErrors, type Diagnostic } from "./diagnostic.ts";
import { checkImplementationPhase, testsLinkedTo, type ImplementationPhaseOptions, type ImplementationPhaseResult } from "./implementation-phase.ts";
import { toProjectPath } from "./location.ts";
import { compareLocks, compareWithBase, readBaseLocks, readLockFile } from "./locks.ts";
import { checkReviews, type ReviewStatus } from "./review-record.ts";
import { readStrictOptions, type StrictOptions, type TypeScriptInfo } from "./typescript.ts";

export type Phase = "design" | "implementation";

/**
 * The report of `cage check`. What was not looked at is `null` or
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
  counts: {
    contracts: number | null;
    data: number | null;
    invariants: number | null;
    implementations: number | null;
    testDeclarations: number | null;
    linkedInvariants: number | null;
    /** Invariants not checked for a test because a rejected tag names their contract. */
    uncheckedInvariants: number | null;
    /** Invariants whose contract has a fresh recorded review that finds them adequate. Null when reviews are not checked. */
    reviewedInvariants: number | null;
    /** Invariants a fresh review finds weak, unrelated or lacking context. */
    weakInvariants: number | null;
  };
  /**
   * `review`: what a fresh recorded review says about the invariant — `adequate`, `weak`, `unrelated`, `insufficient-context` —
   * or null when there is no fresh review of its contract (or reviews are not checked).
   */
  invariants: { contract: string; id: string; member: string | null; linkedTestCount: number | null; review: string | null }[] | null;
  /**
   * What the designs declare, for a tool or an agent that needs the index
   * rather than the documents: contracts with their members, locks and
   * implementations, data types, and the declared dependencies between
   * modules. `implementations` is null when they were not checked. Null as a
   * whole when the designs were not indexed.
   */
  index: {
    contracts: {
      name: string;
      module: string;
      description: string | null;
      shape: "object" | "callable";
      lock: LockLevel | null;
      members: { name: string; description: string | null; location: SourceLocation }[];
      implementations: { name: string; kind: "class" | "function" | "const"; compatible: boolean; location: SourceLocation }[] | null;
      location: SourceLocation;
    }[];
    data: { name: string; module: string; description: string | null; lock: LockLevel | null; location: SourceLocation }[];
    edges: Edge[];
  } | null;
  diagnostics: Diagnostic[];
}

export interface CheckOptions {
  /** A Git revision: the lock file is then also compared with the one recorded there, so that a lock cannot be lifted by editing the file. */
  lockBase?: string;
  /** Whether a contract without a fresh recorded review is reported, and how; the full check only. */
  review?: "off" | "warn" | "require";
}

export function runCheck(options: ImplementationPhaseOptions, phase: Phase, { lockBase, review = "off" }: CheckOptions = {}): CheckReport {
  const root = path.resolve(options.root);
  const design = phase === "design" ? checkDesignPhase(options) : undefined;
  const result: ImplementationPhaseResult = design ? { ...design, designSound: !hasErrors(design.diagnostics), linking: null } : checkImplementationPhase(options);
  const { index, linking, typescript, compiler, diagnostics } = result;
  // Locks are compared with designs that are sound: a rejected declaration would look like a lock that was lifted.
  const designsAreSound = index !== null && result.designSound;
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
  // Reviews are about material that only the full check establishes: implementations and tests.
  let reviewStatus: Map<string, ReviewStatus> | null = null;
  if (configured && review !== "off" && phase === "implementation" && result.linking) {
    const reviews = checkReviews(root, result, review, options.sources.implementations);
    diagnostics.push(...reviews.diagnostics);
    diagnostics.sort(compareDiagnostics);
    reviewStatus = reviews.status;
  }
  const linkedTestCount = (contract: string, id: string) => (linking ? testsLinkedTo(linking.tests, contract, id).length : null);
  const reviewOf = (contract: string, id: string): string | null => {
    const findings = reviewStatus?.get(contract)?.findings ?? null;
    if (!findings) return null;
    // The worst finding about the invariant counts; a finding about the contract as a whole does not stand in for one.
    const about = findings.filter((finding) => finding.invariant === id).map((finding) => finding.assessment);
    return about.find((assessment) => assessment !== "adequate") ?? about[0] ?? null;
  };
  const invariants = index?.invariants.map(({ contract, id, member }) => ({ contract, id, member, linkedTestCount: linkedTestCount(contract, id), review: reviewOf(contract, id) })) ?? null;
  return {
    schemaVersion: 1,
    command: "check",
    phase,
    ok: !hasErrors(diagnostics),
    scope: {
      tsconfig: options.tsconfig,
      designFiles: options.designs.flatMap((design) => design.sourceFiles.map((file) => toProjectPath(root, file))),
      typescript,
      compilerOptions: compiler ? readStrictOptions(compiler.ts, compiler.options) : null,
      lockBase: configured && lockBase !== undefined ? lockBase : null,
    },
    counts: {
      contracts: index?.contracts.length ?? null,
      data: index?.data.length ?? null,
      invariants: index?.invariants.length ?? null,
      implementations: linking?.implementations.length ?? null,
      // One `it` tagged for two contracts is one declaration.
      testDeclarations: linking ? new Set(linking.tests.map((test) => `${test.location.file}:${test.location.line}:${test.location.column}`)).size : null,
      linkedInvariants: linking && invariants ? invariants.filter((invariant) => invariant.linkedTestCount !== 0).length : null,
      uncheckedInvariants: linking?.uncheckedInvariants ?? null,
      // A linked test is a tag; whether it proves anything is what the review says. Null when reviews are not checked.
      reviewedInvariants: reviewStatus && invariants ? invariants.filter((invariant) => invariant.review === "adequate").length : null,
      weakInvariants: reviewStatus && invariants ? invariants.filter((invariant) => invariant.review !== null && invariant.review !== "adequate").length : null,
    },
    invariants,
    index: index
      ? {
          contracts: index.contracts.map(({ name, module, description, shape, lock, members, location }) => ({
            name,
            module,
            description,
            shape,
            lock,
            members,
            implementations: linking ? linking.implementations.filter((implementation) => implementation.contract === name).map(({ name: implementation, kind, compatible, location: at }) => ({ name: implementation, kind, compatible, location: at })) : null,
            location,
          })),
          data: index.data.map(({ name, module, description, lock, location }) => ({ name, module, description, lock, location })),
          edges: index.edges,
        }
      : null,
    diagnostics,
  };
}
