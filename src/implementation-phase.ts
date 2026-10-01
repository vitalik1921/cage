import fs from "node:fs";
import path from "node:path";
import type ts from "typescript";
import type { Contract, Implementation, Invariant, SourceLocation, TestDeclaration } from "./design-model.ts";
import { checkDesignPhase, createConverter, environmentDiagnostics, type Converter, type DesignPhaseOptions, type DesignPhaseResult, type Origin } from "./design-phase.ts";
import { IGNORE_FILE, ownerOf, readModuleScopes, type ModuleScope } from "./coverage.ts";
import { compareDiagnostics, hasErrors, type Diagnostic } from "./diagnostic.ts";
import type { SourceFiles } from "./discovery.ts";
import { readImplementations, type FoundImplementation } from "./implementations.ts";
import { stripBom, toProjectPath } from "./location.ts";
import { BINDING_TAGS } from "./metadata.ts";
import { readTestDeclarations, type RejectedLink, type TestAdapter } from "./test-declarations.ts";
import { createOverlayProgram, readStrictOptions, requireSourceFile, syntaxOnlyOptions, type Overlay, type TypeScript } from "./typescript.ts";

export interface ImplementationPhaseOptions extends DesignPhaseOptions {
  /** Implementation and test files of the scope, relative to `root`. */
  sources: SourceFiles;
  /** The test runner whose declarations are read. */
  testAdapter: TestAdapter;
  /** Exported code of a designed module without `@implements`: not looked at, a warning, or an error. Default: a warning. */
  coverage?: "off" | "warn" | "require";
}

/** The test declarations that link an invariant: inside a `@tests` suite of its contract, with its id in `@covers`. */
export function testsLinkedTo(tests: readonly TestDeclaration[], contract: string, invariant: string): TestDeclaration[] {
  return tests.filter((test) => test.contract === contract && test.covers.includes(invariant));
}

export interface ImplementationPhaseResult extends DesignPhaseResult {
  /** Whether the design phase ended without errors: only then are implementations and tests looked at. */
  designSound: boolean;
  /**
   * Implementations and test declarations. Null when they were not read,
   * which is not "none found": the design phase had errors, or the compiler
   * setup turned out unusable once the project's files were part of it.
   */
  linking: {
    implementations: Implementation[];
    tests: TestDeclaration[];
    /** Invariants not checked for a test because a rejected tag names their contract: fixing the tag may reveal them. */
    uncheckedInvariants: number;
  } | null;
}

/** A source file the phase reads closely, as it is on the disk. */
interface TaggedFile {
  /** Project-relative path. */
  file: string;
  fileName: string;
  text: string;
  /** Whether the text mentions a binding tag. */
  tagged: boolean;
  /** The module whose design should cover the file; undefined outside every module, or when the module ignores it. */
  owner: ModuleScope | undefined;
}

/**
 * Implementation phase: everything of the design phase, then whether the
 * generated files are current, whether each contract has tagged
 * implementations that the compiler accepts in its place, and whether each
 * invariant has a test declaration tagged with it. Test code is read, never
 * run: a linked declaration says that a test exists, not that it passes.
 */
export function checkImplementationPhase(options: ImplementationPhaseOptions): ImplementationPhaseResult {
  const root = path.resolve(options.root);
  const design = checkDesignPhase(options);
  const { modules, index, compiler, diagnostics } = design;
  if (hasErrors(diagnostics) || !index || !compiler) return { ...design, designSound: false, linking: null };
  const { ts, overlay } = compiler;
  const tsconfig = toProjectPath(root, path.resolve(root, options.tsconfig));

  const weak = Object.entries(readStrictOptions(ts, compiler.options)).filter(([, on]) => !on).map(([name]) => name);
  if (weak.length > 0) {
    diagnostics.push({
      code: "W_WEAK_TYPECHECK",
      severity: "warning",
      message: `The project's compiler options weaken the comparison of implementations with contracts: ${weak.join(", ")} ${weak.length === 1 ? "is" : "are"} off.`,
      file: tsconfig,
    });
  }

  const unreadable = (what: string, file: string, cause: unknown): Diagnostic => ({
    code: "E_ENVIRONMENT",
    severity: "error",
    message: `Cannot read the ${what}: ${(cause as Error).message}`,
    file,
  });
  const coverage = options.coverage ?? "warn";
  const { scopes, diagnostics: ignoreProblems } = readModuleScopes(root, modules.map((module) => module.moduleId));
  diagnostics.push(...ignoreProblems);

  // Files that mention a binding tag are read closely, and so are the files of a module with a design, which is
  // expected to cover them. The rest of the project is not the harness's to lint.
  const mentionsTag = new RegExp(`@(${[...BINDING_TAGS].join("|")})(?![A-Za-z0-9-])`);
  const read = (files: readonly string[], expectDesign: boolean): TaggedFile[] =>
    files.flatMap((file) => {
      const fileName = path.join(root, file);
      const module = expectDesign && coverage !== "off" ? ownerOf(scopes, file) : undefined;
      const owner = module && !module.ignores(file) ? module : undefined;
      try {
        const text = stripBom(fs.readFileSync(fileName, "utf8"));
        const tagged = mentionsTag.test(text);
        return tagged || owner ? [{ file, fileName, text, tagged, owner }] : [];
      } catch (cause) {
        diagnostics.push(unreadable("source file", file, cause));
        return [];
      }
    });
  const testFiles = read(options.sources.tests, false);

  const contracts = new Map(index.contracts.map((contract) => [contract.name, contract]));
  const { found, implementationFiles, attempted } = findImplementations(ts, root, read(options.sources.implementations, true), contracts, coverage === "require" ? "require" : "warn", diagnostics);

  // One in-memory file per implementation asks the compiler whether it fits its contract.
  const checks = found.map((implementation, order) => {
    const contract = contracts.get(implementation.contract)!;
    const implementationFile = path.join(root, implementation.location.file);
    const fileName = `${implementationFile.slice(0, -".ts".length)}.cage-check-${order + 1}.ts`;
    const designFile = modules.find((module) => module.moduleId === contract.module)!.virtualFile;
    const subject = implementation.kind === "class" ? `implementation.${implementation.name}` : `typeof implementation.${implementation.name}`;
    const text = [
      `import type * as implementation from ${JSON.stringify(specifierFor(overlay, fileName, implementationFile))};`,
      `import type * as design from ${JSON.stringify(specifierFor(overlay, fileName, designFile))};`,
      `declare const value: ${subject};`,
      `value satisfies design.${contract.name};`,
      "",
    ].join("\n");
    return { implementation, contract, fileName, text };
  });
  // The compiler gets the very text that was just read, not a second read of the disk.
  const sources = [...implementationFiles, ...testFiles];
  overlay.add(new Map([...sources.map(({ fileName, text }): [string, string] => [fileName, text]), ...checks.map((check): [string, string] => [check.fileName, check.text])]));

  // The project's own files are part of the program for the sake of its global declarations.
  const roots = [...compiler.fileNames, ...modules.map((module) => module.virtualFile), ...sources.map(({ fileName }) => fileName), ...checks.map((check) => check.fileName)];
  const program = overlay.createProgram([...new Set(roots)]);
  const origins = new Map(modules.map((module): [ts.SourceFile, Origin] => [requireSourceFile(program, module.virtualFile), { module, extracted: module.generated }]));
  const convert = createConverter(ts, root, program, origins);

  // The design phase checked the compiler setup with the designs alone; with the project's files as roots
  // there can be more, such as a file the tsconfig lists and the disk does not have.
  const setupProblems = [...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics()];
  if (setupProblems.length > 0) {
    diagnostics.push(...environmentDiagnostics(convert, tsconfig, setupProblems));
    diagnostics.sort(compareDiagnostics);
    return { ...design, designSound: true, linking: null };
  }

  // A file the harness makes a claim about must itself be sound: a type error in it makes its types unreliable.
  for (const { fileName } of implementationFiles) {
    const sourceFile = requireSourceFile(program, fileName);
    diagnostics.push(...[...program.getSyntacticDiagnostics(sourceFile), ...program.getSemanticDiagnostics(sourceFile)].map((diagnostic) => convert("E_TYPESCRIPT", diagnostic)));
  }

  const checker = program.getTypeChecker();
  const implementations = checks.map(({ implementation, contract, fileName }): Implementation => {
    const sourceFile = requireSourceFile(program, fileName);
    const [, , declaration, question] = sourceFile.statements;
    // `value` must have the type of the implementation and be compared with the contract: if either name did not
    // resolve, the comparison would be with `any` and would pass whatever the implementation is.
    const names = [declaration, question].map((statement) => lastIdentifier(ts, statement));
    if (names.some((name) => !name || !checker.getSymbolAtLocation(name))) {
      throw new Error(`Cannot compare ${implementation.name} in ${implementation.location.file} with contract ${contract.name}: the comparison did not resolve.`);
    }
    const mismatches = program.getSemanticDiagnostics(sourceFile).filter((diagnostic) => diagnostic.start !== undefined && diagnostic.start >= question.getStart(sourceFile));
    const checkFile = toProjectPath(root, fileName);
    for (const mismatch of mismatches) {
      const converted = convert("E_TYPE_MISMATCH", mismatch);
      // The in-memory file is not something the author can open: leave out what points into it.
      const explained = (converted.related ?? []).filter((related) => related.file !== checkFile);
      diagnostics.push({
        code: "E_TYPE_MISMATCH",
        severity: "error",
        message: `"${implementation.name}" does not fit contract "${contract.name}".\n${converted.message}`,
        ...implementation.location,
        tsCode: mismatch.code,
        contract: contract.name,
        related: [{ message: "The contract.", ...contract.location }, ...explained],
      });
    }
    const { name, kind, location } = implementation;
    return { contract: contract.name, name, kind, compatible: mismatches.length === 0, location };
  });

  const { tests, rejected } = readTests(ts, program, convert, options.testAdapter, testFiles, contracts, index.invariants, diagnostics);

  for (const contract of contracts.values()) {
    // A rejected `@implements`, or one in a file that could not be read, is already reported; "no implementation" would be its consequence.
    if (attempted.has(contract.name) || implementations.some((implementation) => implementation.contract === contract.name)) continue;
    diagnostics.push({
      code: "E_IMPLEMENTATION_MISSING",
      severity: "error",
      message: `Contract "${contract.name}" has no implementation: no exported class, function or const is marked \`@implements ${contract.name}\`.`,
      ...contract.location,
      contract: contract.name,
    });
  }
  let uncheckedInvariants = 0;
  for (const invariant of index.invariants) {
    if (testsLinkedTo(tests, invariant.contract, invariant.id).length > 0) continue;
    // Likewise for a link that was written but rejected; the summary says how many invariants wait on such a tag.
    const about = (link: RejectedLink) => link.contract === null || link.contract === invariant.contract;
    if (rejected.some((link) => about(link) && (link.invariants === "all" || link.invariants.includes(invariant.id)))) {
      uncheckedInvariants += 1;
      continue;
    }
    diagnostics.push({
      code: "E_TEST_MISSING",
      severity: "error",
      message: `Invariant ${invariant.contract}: ${invariant.id} has no linked test declaration.`,
      ...invariant.location,
      contract: invariant.contract,
      invariant: invariant.id,
    });
  }

  diagnostics.sort(compareDiagnostics);
  return { ...design, designSound: true, linking: { implementations, tests, uncheckedInvariants } };
}

const unknownContract = (tag: string, name: string, location: SourceLocation): Diagnostic => ({
  code: "E_REFERENCE_UNKNOWN",
  severity: "error",
  message: `\`@${tag} ${name}\`: there is no contract with this name.`,
  ...location,
});

/** The names that follow a tag anywhere in a text: what a file that cannot be parsed was, by the look of it, trying to link. */
function namesAfterTag(text: string, tag: string): string[] {
  return [...text.matchAll(new RegExp(`@${tag}[ \\t]+([\\p{ID_Start}_$][\\p{ID_Continue}$]*)`, "gu"))].map((match) => match[1]);
}

/**
 * Reads `@implements` from the tagged files. A file with syntax errors is
 * reported and not read: its tree is not what the author wrote.
 */
function findImplementations(
  ts: TypeScript,
  root: string,
  files: readonly TaggedFile[],
  contracts: ReadonlyMap<string, Contract>,
  coverage: "warn" | "require",
  diagnostics: Diagnostic[],
) {
  const found: FoundImplementation[] = [];
  /** Files with an `@implements` on a declaration: the ones the harness makes a claim about. */
  const implementationFiles: TaggedFile[] = [];
  /** Contracts named by an `@implements` that was rejected or is in a file that could not be read. */
  const attempted = new Set<string>();

  const { program } = createOverlayProgram(ts, syntaxOnlyOptions, new Map(files.map(({ fileName, text }) => [fileName, text])));
  const convert = createConverter(ts, root, program, new Map());
  for (const tagged of files) {
    const sourceFile = requireSourceFile(program, tagged.fileName);
    const syntax = program.getSyntacticDiagnostics(sourceFile);
    if (syntax.length > 0) {
      // A broken file without tags is the project's own business.
      if (!tagged.tagged) continue;
      diagnostics.push(...syntax.map((diagnostic) => convert("E_TYPESCRIPT", diagnostic)));
      for (const name of namesAfterTag(tagged.text, "implements")) attempted.add(name);
      continue;
    }
    const read = readImplementations(ts, sourceFile, tagged.file, tagged.tagged);
    diagnostics.push(...read.diagnostics);
    if (tagged.owner) {
      const { moduleId } = tagged.owner;
      for (const declaration of read.exported) {
        if (declaration.claimed) continue;
        diagnostics.push({
          code: coverage === "require" ? "E_NOT_DESIGNED" : "W_NOT_DESIGNED",
          severity: coverage === "require" ? "error" : "warning",
          message:
            `Exported ${declaration.kind} "${declaration.name}" is not covered by the design of ${moduleId}: nothing marks it \`@implements\`. ` +
            `Describe its contract in the design, or list the file in ${path.posix.join(moduleId, IGNORE_FILE)}.`,
          ...declaration.location,
        });
      }
    }
    for (const name of read.rejected) attempted.add(name);
    if (read.found.length > 0) implementationFiles.push(tagged);
    for (const implementation of read.found) {
      if (contracts.has(implementation.contract)) found.push(implementation);
      else diagnostics.push(unknownContract("implements", implementation.contract, implementation.tagLocation));
    }
  }
  return { found, implementationFiles, attempted };
}

/** The last identifier of the type a check statement names: `X` of `implementation.X`, `C` of `design.C`. */
function lastIdentifier(ts: TypeScript, statement: ts.Statement): ts.Identifier | undefined {
  let last: ts.Identifier | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node)) last = node;
    ts.forEachChild(node, visit);
  };
  visit(statement);
  return last;
}

/** A relative specifier, as written in `fromFile`, that the project's module resolution takes to `target`. */
function specifierFor(overlay: Overlay, fromFile: string, target: string): string {
  const relative = path.relative(path.dirname(fromFile), target).split(path.sep).join("/");
  // A path into a dot-directory starts with a dot too, so test for the parent prefix, not for a dot.
  const base = (relative.startsWith("../") ? relative : `./${relative}`).replace(/\.ts$/, "");
  const specifier = [`${base}.js`, `${base}.ts`, base].find((candidate) => {
    const resolved = overlay.resolveFrom(candidate, fromFile);
    return resolved !== undefined && overlay.sameFile(resolved, target);
  });
  if (specifier === undefined) throw new Error(`Cannot import ${target} from ${fromFile} under the project's module resolution.`);
  return specifier;
}

function readTests(
  ts: TypeScript,
  program: ts.Program,
  convert: Converter,
  adapter: TestAdapter,
  files: readonly TaggedFile[],
  contracts: ReadonlyMap<string, Contract>,
  invariants: readonly Invariant[],
  diagnostics: Diagnostic[],
): { tests: TestDeclaration[]; rejected: RejectedLink[] } {
  const checker = program.getTypeChecker();
  const tests: TestDeclaration[] = [];
  const rejected: RejectedLink[] = [];
  for (const { file, fileName, text } of files) {
    const sourceFile = requireSourceFile(program, fileName);
    // With syntax errors the tree is not what the author wrote; report them instead of guessing declarations.
    const syntax = program.getSyntacticDiagnostics(sourceFile);
    if (syntax.length > 0) {
      diagnostics.push(...syntax.map((diagnostic) => convert("E_TYPESCRIPT", diagnostic)));
      for (const contract of namesAfterTag(text, "tests")) rejected.push({ contract, invariants: "all" });
      continue;
    }
    const read = readTestDeclarations(ts, checker, sourceFile, file, adapter);
    diagnostics.push(...read.diagnostics);
    rejected.push(...read.rejected);
    // An unknown contract is reported once, at its `@tests`; what the tests under it cover is then not looked at.
    for (const context of read.contexts) for (const name of context.contracts) if (!contracts.has(name)) diagnostics.push(unknownContract("tests", name, context.location));
    for (const test of read.tests) {
      const named = test.context.contracts;
      if (named.some((name) => !contracts.has(name))) continue;
      // Each id goes to the one contract among the named that has it; a test is then a declaration of every contract it covers something of.
      const covers = new Map<string, string[]>(named.map((name) => [name, []]));
      const quoted = (names: readonly string[]) => names.map((name) => `"${name}"`).join(" and ");
      for (const { id, location } of test.covers) {
        const owners = named.filter((name) => invariants.some((invariant) => invariant.contract === name && invariant.id === id));
        if (owners.length === 1) {
          covers.get(owners[0])!.push(id);
        } else if (owners.length > 1) {
          // Reported here; "has no test" for the invariant in either contract would be the consequence.
          for (const owner of owners) rejected.push({ contract: owner, invariants: [id] });
          diagnostics.push({
            code: "E_REFERENCE_AMBIGUOUS",
            severity: "error",
            message: `\`@covers ${id}\`: ${quoted(owners)} both have an invariant with this id; give this test its own \`@tests\` line naming the one it demonstrates.`,
            ...location,
            contract: owners[0],
          });
        } else {
          // The id may be another contract's: then the test wants that contract named too.
          const elsewhere = invariants.find((invariant) => invariant.id === id && contracts.has(invariant.contract));
          const hint = elsewhere ? ` "${elsewhere.contract}" has one: name it in the tag too (\`@tests ${[...named, elsewhere.contract].join(" ")}\`), or give the test its own \`@tests ${elsewhere.contract}\` line.` : "";
          diagnostics.push({
            code: "E_REFERENCE_UNKNOWN",
            severity: "error",
            message: `\`@covers ${id}\`: ${named.length === 1 ? "contract" : "contracts"} ${quoted(named)} ${named.length === 1 ? "has" : "have"} no invariant with this id.${hint}`,
            ...location,
            contract: named[0],
          });
        }
      }
      // A test that covers nothing of a named contract is still its declaration when it is the only one named: it is counted, and reviewed, there.
      for (const [name, ids] of covers) {
        if (ids.length === 0 && named.length > 1) continue;
        tests.push({ title: test.title, suitePath: test.suitePath, adapter, contract: name, covers: ids, location: test.location });
      }
    }
  }
  return { tests, rejected };
}
