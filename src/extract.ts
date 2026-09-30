import { checkDesignPhase, type DesignPhaseOptions } from "./design-phase.ts";
import { compareDiagnostics, hasErrors, type Diagnostic } from "./diagnostic.ts";
import { inspectOutput, outputProblem, writeOutput } from "./generated-files.ts";

export type OutputStatus = "written" | "unchanged" | "missing" | "stale" | "conflict" | "failed";

export interface ExtractOutput {
  /** The design document, relative to the project root. */
  source: string;
  /** The generated file, relative to the project root. */
  path: string;
  status: OutputStatus;
  /** Why the file could not be read or written, for status "failed". */
  error?: string;
}

export interface ExtractReport {
  schemaVersion: 1;
  command: "extract";
  checkOnly: boolean;
  /** False when the configuration turns generated files off: then there are no outputs. */
  generatedFiles: boolean;
  ok: boolean;
  outputs: ExtractOutput[];
  diagnostics: Diagnostic[];
}

/**
 * Synchronizes every design.generated.ts with its design document, or with
 * `checkOnly` reports which ones are not current. Nothing is written when the
 * design phase has errors, or when any output is in conflict or unreadable.
 * In a project that keeps no generated files only the designs are checked.
 */
export function runExtract(options: DesignPhaseOptions, checkOnly: boolean, generatedFiles = true): ExtractReport {
  const { modules, diagnostics } = checkDesignPhase(options);
  const outputs: ExtractOutput[] = [];

  if (generatedFiles && !hasErrors(diagnostics)) {
    const fail = (output: ExtractOutput, action: string, cause: unknown) => {
      output.status = "failed";
      output.error = (cause as Error).message;
      diagnostics.push({ code: "E_ENVIRONMENT", severity: "error", message: `Cannot ${action} the generated file: ${output.error}`, file: output.path });
    };

    const states = modules.map((module) => {
      const output: ExtractOutput = {
        source: module.file,
        path: module.generatedPath,
        status: "unchanged",
      };
      outputs.push(output);
      try {
        return inspectOutput(module.generatedFile, module.generated.text);
      } catch (cause) {
        fail(output, "read", cause);
        return undefined;
      }
    });

    const mayWrite = !checkOnly && states.every((state) => state !== undefined && state !== "conflict");
    states.forEach((state, index) => {
      const output = outputs[index];
      if (state === undefined || state === "current") return;
      if (mayWrite) {
        try {
          writeOutput(modules[index].generatedFile, modules[index].generated.text);
          output.status = "written";
        } catch (cause) {
          fail(output, "write", cause);
        }
        return;
      }
      output.status = state;
      if (checkOnly || state === "conflict") diagnostics.push(outputProblem(state, output.path, output.source));
    });
  }

  return { schemaVersion: 1, command: "extract", checkOnly, generatedFiles, ok: !hasErrors(diagnostics), outputs, diagnostics: diagnostics.sort(compareDiagnostics) };
}
