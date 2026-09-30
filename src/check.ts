import path from "node:path";
import { checkDesignPhase, type DesignPhaseOptions } from "./design-phase.ts";
import { hasErrors, type Diagnostic } from "./diagnostic.ts";
import { toProjectPath } from "./location.ts";
import type { TypeScriptInfo } from "./typescript.ts";

/**
 * The report of `design check --phase design`. What was not looked at is
 * `null` or "not-checked", never 0 or "current": "not checked" is not "not
 * found". This phase never looks at generated files, implementations and
 * tests; contracts are not counted when an error stopped the check before
 * the designs were indexed.
 */
export interface CheckReport {
  schemaVersion: 1;
  command: "check";
  phase: "design";
  ok: boolean;
  scope: { tsconfig: string; designFiles: string[]; typescript: TypeScriptInfo };
  generatedArtifacts: { source: string; file: string; status: "not-checked" }[];
  counts: {
    contracts: number | null;
    data: number | null;
    invariants: number | null;
    implementations: null;
    testDeclarations: null;
    linkedInvariants: null;
  };
  invariants: { contract: string; id: string; member: string | null; linkedTestCount: null }[] | null;
  diagnostics: Diagnostic[];
}

export function runDesignCheck(options: DesignPhaseOptions): CheckReport {
  const root = path.resolve(options.root);
  const { modules, index, typescript, diagnostics } = checkDesignPhase(options);
  return {
    schemaVersion: 1,
    command: "check",
    phase: "design",
    ok: !hasErrors(diagnostics),
    scope: { tsconfig: options.tsconfig, designFiles: options.designs.map((design) => toProjectPath(root, design.sourceFile)), typescript },
    generatedArtifacts: modules.map((module) => ({ source: module.file, file: module.generatedPath, status: "not-checked" })),
    counts: {
      contracts: index?.contracts.length ?? null,
      data: index?.data.length ?? null,
      invariants: index?.invariants.length ?? null,
      implementations: null,
      testDeclarations: null,
      linkedInvariants: null,
    },
    invariants: index?.invariants.map(({ contract, id, member }) => ({ contract, id, member, linkedTestCount: null })) ?? null,
    diagnostics,
  };
}
