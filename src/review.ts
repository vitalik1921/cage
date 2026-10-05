import path from "node:path";
import type { Contract, LockLevel, SourceLocation, TestStatus } from "./design-model.ts";
import type { DesignModule } from "./design-phase.ts";
import { compareDiagnostics, compareText, hasErrors, type Diagnostic } from "./diagnostic.ts";
import { checkImplementationPhase, type ImplementationPhaseOptions, type ImplementationPhaseResult } from "./implementation-phase.ts";
import { toProjectPath } from "./location.ts";
import { collectMaterial, createFileReader, externalUses, fingerprintOf, type ExternalUse, type FileReader, type Material, type PacketFile } from "./review-material.ts";
import { ASSESSMENTS, countAssessments, findsFault, notesOf, readReviewFile, scopeDiagnostics, VERDICTS_SCHEMA, type Assessment, type ReviewEntry } from "./review-record.ts";
import type { Overlay, TypeScript } from "./typescript.ts";

export type { PacketFile } from "./review-material.ts";

/** Everything the harness knows about one contract, with pointers into `files`. */
export interface ContractPacket {
  contract: string;
  module: string;
  /**
   * What a review of the contract is about: a digest of the contract's
   * declaration, of each implementation and of each test declared for it. It
   * changes when any of those changes, not when something else in their
   * files does, and a verdict is recorded against it.
   */
  fingerprint: string;
  /** The module's design documents. */
  designs: string[];
  description: string | null;
  lock: LockLevel | null;
  members: { name: string; description: string | null; location: SourceLocation }[];
  invariants: { id: string; text: string; member: string | null; location: SourceLocation; tests: { file: string; line: number; column: number; title: string }[] }[];
  dependencies: {
    uses: { contract: string; module: string }[];
    usedBy: { contract: string; module: string }[];
    /** Design documents of the contracts it uses and of the designs its module imports types from. */
    designs: string[];
  };
  implementations: { name: string; kind: "class" | "function" | "const"; compatible: boolean; location: SourceLocation }[];
  tests: {
    file: string;
    /** `status` is what the test's text says (a skip, a todo, an empty body); cage does not run it. */
    declarations: { title: string; suitePath: string[]; covers: string[]; status: TestStatus; inactiveBecause?: string; line: number; column: number }[];
  }[];
  /** Files outside the module that import an implementation of the contract: they rely on its promises; with the members they call, where that is visible. */
  usedBy: ExternalUse[];
  /** The contract-level findings of the recorded review, first sentence each, led by the assessment when it is not adequate: observations that stay until the design's owner acts on them. */
  priorNotes: string[];
  /** Project files the test files import, loaded into `files` as helpers: a stub or a fixture decides what a test observes. */
  helpers: string[];
  /** Local files whose content is part of the fingerprint, loaded or not: a change in any of them makes this review outdated. */
  fingerprinted: string[];
  /** Project files that the packet's files import but that are not in the packet, with who imports what: the reviewer opens them in the repository. */
  unloaded: { file: string; importedBy: { file: string; names: string[] }[] }[];
  /** Test files of the module that the `tests` patterns match but that declare nothing for any contract: proof may be waiting there for a tag. */
  untaggedTests: string[];
  /** What the check found about this contract or in its files. */
  diagnostics: Diagnostic[];
  /**
   * What `.cage/review.json` holds for the contract: no verdict, a verdict for
   * other material, one for this material with the count of each assessment
   * (of the invariants, and of the contract as a whole apart), or "unknown"
   * when the file cannot be used. A verdict is a reviewer's assessment, not a
   * proof and not a test run.
   */
  recordedReview: {
    status: "none" | "outdated" | "current" | "unknown";
    assessments: Record<Assessment, number> | null;
    contractAssessments: Record<Assessment, number> | null;
  };
}

export interface ReviewReport {
  schemaVersion: 1;
  command: "review";
  /** Whether the packets could be made: every named contract exists and the designs were indexed. */
  ok: boolean;
  /** False when the check found errors: the reviewer sees material that the harness has already rejected in part. */
  complete: boolean;
  /** "needed": the contracts without a recorded review or whose material changed since; the default. */
  selection: "all" | "named" | "needed";
  instruction: string;
  resultFormat: typeof RESULT_FORMAT;
  /** The same as a JSON Schema, for a reviewer that can be held to one. */
  resultSchema: typeof VERDICTS_SCHEMA;
  contracts: ContractPacket[];
  files: PacketFile[];
  diagnostics: Diagnostic[];
}

export const INSTRUCTION = [
  "You are reviewing whether the tests of each contract really check what its invariants promise. The harness has already checked the structure:",
  "every invariant below has at least one test declaration tagged with it unless a diagnostic says otherwise. What it cannot check is the substance,",
  "and that is your task. For each invariant, read the tests that cover it, the implementation and the design, and judge:",
  "",
  "- Does the test exercise the behaviour the invariant is about, or the right external scenario?",
  "- Would it fail if exactly this promise were broken, and only then?",
  "- Do the assertions observe the right result, order or effect — not just that nothing was thrown?",
  "- Do mocks or stubs stand in for the very guarantee the test claims to check? A test that asserts the exact statement, clause or call that carries the promise",
  "  is adequate for that clause; a clause left unasserted while a stub returns a canned result regardless is weak; what only a real database or service",
  "  can show (one row kept, an id unchanged, a value the column type rejects) is weak even when the clause is asserted, unless a test against the",
  "  real thing is linked — say which test to tag. The helpers the tests import are loaded with them: read the stub before judging what a test observes.",
  "- A boundary the contract's types allow counts even when today's callers cannot reach it (\"\" where the type says string, undefined where it says",
  "  an object): the contract is the promise, not the callers. Say so in the reason; the design's owner may narrow the type instead.",
  "- Are the relevant errors, boundaries, concurrency and retries covered?",
  "- For a rule about the whole interface: is the interaction of methods checked?",
  "- Where there are several implementations, does each have the scenarios it needs?",
  "- Does the implementation do more than the invariant says (an extra condition the tests never touch)?",
  "- Does the business description add material requirements, or contradict the invariants?",
  "",
  "Assess each invariant as `adequate`, `weak`, `unrelated` or `insufficient-context`, with a reason and the evidence (file and line) it rests on;",
  "evidence is null only for insufficient-context, and may cite a file the packet does not hold when you opened it in the repository. An observation",
  "about the design or the code that is not a test weakness goes in a contract-level finding (invariant null, assessment adequate): several may",
  "stand next to the per-invariant findings; `cage review --record` prints them, the next packet of the contract repeats them, and they are not",
  "counted as assessments of invariants. A contract-level finding assessed otherwise is a finding against the contract as a whole: `cage check`",
  "reports it like a weak invariant. Files used outside the module rely on the contract's promises: a change to an invariant reaches them, and they may",
  "assume the old one — say so in a contract-level finding.",
  "This is an assessment, not a proof and not a test run. A contract without invariants gets one contract-level finding (invariant null).",
  "When you are the agent that wrote the code or the tests under review, judge them as a stranger would: the verdict is recorded and read by others.",
  "Do not remove or soften invariants and do not rewrite business requirements to make a check pass; a missing or weak test is a recommendation",
  "for the implementers, to be run in the project's own test environment. Files listed as not loaded were imported by the material but are not",
  "included: open them in the repository, or say that the context was insufficient. Test files listed as without declarations are matched by the",
  "project's tests patterns but carry no tag: proof may be there, one tag away. `Lock` on a contract is its change policy (@final / @extendable), not",
  "a review matter.",
].join("\n");

/** What a verdict looks like; `cage review --record` reads exactly this. */
export const RESULT_FORMAT = {
  version: 1,
  verdicts: [
    {
      contract: "<contract name>",
      fingerprint: "<the fingerprint of its packet>",
      findings: [
        {
          invariant: "<invariant id, or null for the contract as a whole>",
          assessment: "adequate | weak | unrelated | insufficient-context",
          reason: "<why>",
          evidence: "<file:line the judgement rests on>",
          suggestedChange: "<what to change, or null>",
        },
      ],
    },
  ],
};

/**
 * `cage review`: the material of the selected contracts for a reviewer,
 * human or model, with an instruction and the format of the verdict. Nothing
 * is sent anywhere; the report goes to stdout. It runs the full check first,
 * so that the structural diagnostics come with the material.
 */
export function runReview(options: ImplementationPhaseOptions, names: readonly string[] | "all" | "needed"): ReviewReport {
  const root = path.resolve(options.root);
  const result = checkImplementationPhase(options);
  const diagnostics = [...result.diagnostics];
  let complete = !hasErrors(diagnostics);
  const report = (ok: boolean, contracts: ContractPacket[], files: PacketFile[]): ReviewReport => ({
    schemaVersion: 1,
    command: "review",
    ok,
    complete,
    selection: typeof names === "string" ? names : "named",
    instruction: INSTRUCTION,
    resultFormat: RESULT_FORMAT,
    resultSchema: VERDICTS_SCHEMA,
    contracts,
    files,
    diagnostics: diagnostics.sort(compareDiagnostics),
  });
  const { index } = result;
  if (!index) return report(false, [], []);
  const { read, files } = createFileReader(root, diagnostics);

  let ok = true;
  let selected: Contract[];
  const materials = new Map<string, Material>();
  const materialOf = (name: string) => {
    if (!materials.has(name)) materials.set(name, collectMaterial(result, name, read));
    return materials.get(name)!;
  };
  if (names === "needed") {
    // Without a usable review file every contract needs a review; its problem is reported.
    const reviews = readReviewFile(root);
    diagnostics.push(...reviews.diagnostics);
    selected = index.contracts.filter((contract) => {
      const recorded = reviews.entries.find((entry) => entry.module === contract.module && entry.contract === contract.name);
      return !recorded || recorded.fingerprint !== fingerprintOf(materialOf(contract.name).parts).fingerprint;
    });
  } else {
    selected = names === "all" ? [...index.contracts] : [];
    for (const name of names === "all" ? [] : names) {
      const contract = index.contracts.find((candidate) => candidate.name === name);
      if (contract) {
        if (!selected.includes(contract)) selected.push(contract);
      } else {
        ok = false;
        diagnostics.push({ code: "E_REFERENCE_UNKNOWN", severity: "error", message: `There is no contract "${name}" in the designs.` });
      }
    }
  }
  selected.sort((a, b) => compareText(a.module, b.module) || compareText(a.name, b.name));

  const packets = selected.map((contract) => packetOf(root, result, diagnostics, materialOf(contract.name), options.sources.tests, options.sources.implementations, read));
  // A file of the material that could not be read leaves a packet with a hole: the export is not complete.
  if (packets.some((packet) => packet.diagnostics.some((diagnostic) => diagnostic.code === "E_ENVIRONMENT"))) complete = false;
  const used = new Set(packets.flatMap((packet) => [...packet.designs, ...packet.dependencies.designs, ...packet.implementations.map((i) => i.location.file), ...packet.tests.map((t) => t.file), ...packet.helpers]));
  // A file another packet of this report holds is in the document; it is not "not loaded" for anyone.
  for (const packet of packets) packet.unloaded = packet.unloaded.filter((entry) => !used.has(entry.file));
  return report(ok, packets, [...files.values()].filter((file) => used.has(file.path)).sort((a, b) => compareText(a.path, b.path)));
}

function packetOf(
  root: string,
  result: ImplementationPhaseResult,
  diagnostics: Diagnostic[],
  material: Material,
  testFiles_: readonly string[],
  sourceFiles: readonly string[],
  read: FileReader,
): ContractPacket {
  const { compiler } = result;
  const { contract, own, dependencyDesigns, uses, usedBy, implementations, declarations, testFiles, files } = material;
  // What the bounds of the fingerprint leave out is the reviewer's business too: those files may change without notice.
  diagnostics.push(...scopeDiagnostics(material, "warn").filter((diagnostic) => !diagnostics.some((known) => known.code === diagnostic.code && known.contract === diagnostic.contract && known.file === diagnostic.file)));
  const name = contract.name;
  // What the tests import from the project is part of what they prove: a stub decides whether a test observes anything.
  // Loaded one level deep, test files only; what the implementations import stays listed, not loaded.
  const attempted = new Set<string>();
  if (compiler) {
    for (const file of files.filter((candidate) => candidate.role === "test")) {
      for (const helper of projectImports(root, compiler.ts, compiler.overlay, file).filter((imported) => !files.some((loadedFile) => loadedFile.path === imported))) {
        attempted.add(helper);
        const loadedHelper = read(helper, "helper");
        if (loadedHelper) files.push(loadedHelper);
      }
    }
  }
  const loaded = new Set(files.map((file) => file.path));
  const unloaded = compiler ? importsOutside(root, compiler.ts, compiler.overlay, files, loaded) : [];
  const reviews = readReviewFile(root);
  const prior = reviews.entries.find((entry) => entry.module === contract.module && entry.contract === name);
  const fingerprint = fingerprintOf(material.parts).fingerprint;
  const priorNotes = prior ? notesOf(prior.findings) : [];
  const declaring = new Set((result.linking?.tests ?? []).map((test) => test.location.file));
  const inModule = (file: string) => contract.module === "." || file.startsWith(`${contract.module}/`);
  const untaggedTests = testFiles_.filter((file) => inModule(file) && !declaring.has(file)).sort(compareText);

  const testsOf = (id: string) =>
    declarations
      .filter((test) => test.covers.includes(id))
      .map((test) => ({ file: test.location.file, line: test.location.line, column: test.location.column, title: test.title }));
  return {
    contract: name,
    module: contract.module,
    fingerprint,
    designs: own.documents.map((document) => document.file),
    description: contract.description,
    lock: contract.lock,
    members: contract.members.map(({ name: member, description, location }) => ({ name: member, description, location })),
    invariants: result.index!.invariants.filter((invariant) => invariant.contract === name).map(({ id, text, member, location }) => ({ id, text, member, location, tests: testsOf(id) })),
    dependencies: { uses, usedBy, designs: dependencyDesigns },
    implementations: implementations.map(({ name: implementation, kind, compatible, location }) => ({ name: implementation, kind, compatible, location })),
    tests: testFiles.map((file) => ({
      file,
      declarations: declarations
        .filter((test) => test.location.file === file)
        .map(({ title, suitePath, covers, status, inactiveBecause, location }) => ({ title, suitePath, covers, status, ...(inactiveBecause === undefined ? {} : { inactiveBecause }), line: location.line, column: location.column })),
    })),
    usedBy: compiler ? externalUses(root, compiler.ts, compiler.overlay, implementations, contract.module, contract.members.map((member) => member.name), sourceFiles) : [],
    priorNotes,
    helpers: files.filter((file) => file.role === "helper").map((file) => file.path).sort(compareText),
    fingerprinted: material.dependencies,
    unloaded,
    untaggedTests,
    // What the checks say about the files a reviewer reads belongs here; what is said about another contract's review does not.
    diagnostics: diagnostics
      .filter((diagnostic) => diagnostic.contract === name || (diagnostic.file !== undefined && (loaded.has(diagnostic.file) || attempted.has(diagnostic.file)) && !(diagnostic.contract !== undefined && diagnostic.code.includes("REVIEW_"))))
      .sort(compareDiagnostics),
    recordedReview: recordedReviewOf(reviews.diagnostics.length > 0, prior, fingerprint),
  };
}

function recordedReviewOf(unusable: boolean, prior: ReviewEntry | undefined, fingerprint: string): ContractPacket["recordedReview"] {
  if (unusable) return { status: "unknown", assessments: null, contractAssessments: null };
  if (!prior) return { status: "none", assessments: null, contractAssessments: null };
  if (prior.fingerprint !== fingerprint) return { status: "outdated", assessments: null, contractAssessments: null };
  return { status: "current", ...countAssessments(prior.findings) };
}

/** The project files a file imports, resolved the way the project does; nothing outside the root or in node_modules. */
function projectImports(root: string, ts: TypeScript, overlay: Pick<Overlay, "resolveFrom">, file: PacketFile): string[] {
  const fileName = path.join(root, file.path);
  const sourceFile = ts.createSourceFile(fileName, file.text, ts.ScriptTarget.Latest, false);
  const found: string[] = [];
  for (const statement of sourceFile.statements) {
    const specifier = (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier;
    if (!specifier || !ts.isStringLiteral(specifier)) continue;
    const resolved = overlay.resolveFrom(specifier.text, fileName);
    if (!resolved) continue;
    const projectPath = toProjectPath(root, resolved);
    if (projectPath.startsWith("../") || path.isAbsolute(projectPath) || projectPath.split("/").includes("node_modules") || projectPath.endsWith(".d.ts")) continue;
    if (!found.includes(projectPath)) found.push(projectPath);
  }
  return found;
}

/**
 * Project files that the implementation and test files of a packet import
 * and that the packet does not hold: other modules, schemas.
 */
function importsOutside(
  root: string,
  ts: TypeScript,
  overlay: Pick<Overlay, "resolveFrom">,
  packetFiles: readonly PacketFile[],
  loaded: ReadonlySet<string>,
): ContractPacket["unloaded"] {
  const outside = new Map<string, Map<string, Set<string>>>();
  for (const file of packetFiles) {
    // What a helper imports is one level further from the contract; listing it drowns the files that matter (a NestJS AppModule imports everything).
    if (file.role === "design" || file.role === "helper") continue;
    const fileName = path.join(root, file.path);
    const sourceFile = ts.createSourceFile(fileName, file.text, ts.ScriptTarget.Latest, false);
    for (const statement of sourceFile.statements) {
      const specifier = (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier;
      if (!specifier || !ts.isStringLiteral(specifier)) continue;
      const resolved = overlay.resolveFrom(specifier.text, fileName);
      if (!resolved) continue;
      const projectPath = toProjectPath(root, resolved);
      if (projectPath.startsWith("../") || path.isAbsolute(projectPath) || projectPath.split("/").includes("node_modules") || loaded.has(projectPath)) continue;
      const names = new Set<string>();
      if (ts.isImportDeclaration(statement)) {
        const clause = statement.importClause;
        if (clause?.name) names.add(clause.name.text);
        const bindings = clause?.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) names.add(`* as ${bindings.name.text}`);
        else for (const element of bindings?.elements ?? []) names.add((element.propertyName ?? element.name).text);
      } else {
        const exported = statement.exportClause;
        if (exported && ts.isNamedExports(exported)) for (const element of exported.elements) names.add((element.propertyName ?? element.name).text);
        else names.add("*");
      }
      const importers = outside.get(projectPath) ?? new Map<string, Set<string>>();
      const known = importers.get(file.path) ?? new Set<string>();
      for (const name of names) known.add(name);
      importers.set(file.path, known);
      outside.set(projectPath, importers);
    }
  }
  return [...outside]
    .sort(([a], [b]) => compareText(a, b))
    .map(([file, importers]) => ({ file, importedBy: [...importers].sort(([a], [b]) => compareText(a, b)).map(([importer, names]) => ({ file: importer, names: [...names].sort(compareText) })) }));
}

/** The review as one Markdown document: the instruction, each contract, every file once, and the verdict format. */
/** The marks of the status lines; the same in a terminal and in a pipe, and no colour: the packet is read by people and by models. */
const STATUS = { ok: "✓", attention: "!", problem: "✗", unknown: "○" } as const;

/** What cage knows about a packet, one fact a line: what it collected, what its text says, and what is recorded, kept apart. */
function statusLines(packet: ContractPacket): string[] {
  const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const declarations = packet.tests.flatMap((file) => file.declarations);
  const inactive = declarations.filter((test) => test.status !== "active").length;
  const collected = [count(packet.designs.length, "design"), count(packet.implementations.length, "implementation"), count(declarations.length, "test declaration"), count(packet.helpers.length, "test helper"), `${packet.fingerprinted.length} fingerprinted ${packet.fingerprinted.length === 1 ? "dependency" : "dependencies"}`];
  const errors = packet.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
  const warnings = packet.diagnostics.length - errors;
  const lines = [`- ${STATUS.ok} Material collected: ${collected.join(", ")} — gathered for the reviewer, not judged by cage`];
  if (declarations.length === 0) lines.push(packet.invariants.length === 0 ? `- ${STATUS.attention} Tests: none tagged, and no invariant to link one to` : `- ${STATUS.problem} Tests: no test declaration is tagged for this contract`);
  else if (inactive > 0) lines.push(`- ${STATUS.attention} Tests: ${inactive} of ${count(declarations.length, "declaration")} inactive in the source (skipped, todo, empty, or a broken import in their file); see Tests`);
  else lines.push(`- ${STATUS.ok} Tests: ${declarations.length === 1 ? "the declaration is" : `all ${declarations.length} declarations are`} active in the source (not skipped, todo or empty; their files import nothing broken)`);
  lines.push(`- ${STATUS.unknown} Test results: not known — cage reads the tests, it does not run them`);
  if (errors > 0) lines.push(`- ${STATUS.problem} Structural check: ${count(errors, "error")}${warnings > 0 ? `, ${count(warnings, "warning")}` : ""} about this material; see Diagnostics`);
  else if (warnings > 0) lines.push(`- ${STATUS.attention} Structural check: ${count(warnings, "warning")} about this material; see Diagnostics`);
  else lines.push(`- ${STATUS.ok} Structural check: nothing found about this material (the recorded review is the next line)`);
  const { status, assessments } = packet.recordedReview;
  if (status === "none") lines.push(`- ${STATUS.unknown} Recorded review: none — adequacy is not attested; record a verdict with \`cage review --record\``);
  else if (status === "outdated") lines.push(`- ${STATUS.problem} Recorded review: outdated — it is for other material; the adequacy of this material is not attested`);
  else if (status === "unknown") lines.push(`- ${STATUS.unknown} Recorded review: not known — the review file cannot be used; see Diagnostics`);
  else {
    const listed = (counts: Record<Assessment, number>) => ASSESSMENTS.filter((assessment) => counts[assessment] > 0).map((assessment) => `${counts[assessment]} ${assessment}`).join(", ");
    const invariants = assessments ? listed(assessments) : "";
    const contract = packet.recordedReview.contractAssessments;
    // The contract as a whole is named when the reviewer found fault with it, or when it is all there is.
    const whole = contract && (findsFault(contract) || invariants === "") ? `the contract as a whole: ${listed(contract) || "no finding"}` : "";
    const fault = (assessments !== null && findsFault(assessments)) || (contract !== null && findsFault(contract));
    lines.push(`- ${fault ? STATUS.attention : STATUS.ok} Recorded review: current — a reviewer's verdict on this material: ${[invariants, whole].filter((part) => part !== "").join("; ")}; an assessment, not a proof`);
  }
  return lines;
}

export function formatReviewMarkdown(report: ReviewReport): string {
  const texts = [...report.files.map((file) => file.text), JSON.stringify(report.resultFormat, null, 2)];
  const longest = Math.max(2, ...texts.flatMap((text) => [...text.matchAll(/`+/g)].map((run) => run[0].length)));
  const fence = "`".repeat(longest + 1);
  const at = ({ file, line, column }: Partial<SourceLocation>) => [file, line, column].filter((part) => part !== undefined).join(":");
  const lines: string[] = ["# Design review", "", report.instruction, ""];
  if (!report.complete) lines.push("> The check found errors; they are listed with each contract. Part of the material below has been rejected by the harness.", "");
  if (report.contracts.length === 0) {
    lines.push(report.selection === "needed" && report.ok ? `${STATUS.ok} No contract needs a review: none is without a recorded review of its current material. \`cage review --all\` exports every contract.` : "No contract to review.", "");
  } else {
    lines.push(`Status: ${STATUS.ok} known and in order · ${STATUS.attention} needs a look · ${STATUS.problem} missing, outdated or an error · ${STATUS.unknown} not done or not known by cage.`, "Collected material is not judged material: adequacy comes only from a recorded verdict, and no line here says that a test passed.", "");
  }

  for (const packet of report.contracts) {
    lines.push(`## Contract ${packet.contract} (${packet.module})`, "");
    lines.push(`- Design: ${packet.designs.join(", ")}`);
    lines.push(`- Fingerprint: ${packet.fingerprint}`);
    lines.push(`- Lock: ${packet.lock === null ? "none (open)" : `@${packet.lock}`}`);
    lines.push(`- Description: ${packet.description ?? "none"}`, "");
    lines.push("### Status", "", ...statusLines(packet), "");
    lines.push("### Members", "");
    if (packet.members.length === 0) lines.push("- (a callable contract: one call signature)");
    for (const member of packet.members) lines.push(`- \`${member.name}\` (${at(member.location)})${member.description ? `: ${member.description}` : ""}`);
    lines.push("", "### Invariants", "");
    if (packet.invariants.length === 0) lines.push("- none: assess the contract as a whole");
    for (const invariant of packet.invariants) {
      const tests = invariant.tests.length === 0 ? "no test declaration" : invariant.tests.map((test) => `${test.file}:${test.line} "${test.title}"`).join("; ");
      lines.push(`- \`${invariant.id}\`${invariant.member ? ` on \`${invariant.member}\`` : ""} (${at(invariant.location)}): ${invariant.text}`, `  - tests: ${tests}`);
    }
    lines.push("", "### Implementations", "");
    if (packet.implementations.length === 0) lines.push("- none tagged");
    for (const implementation of packet.implementations) {
      lines.push(`- \`${implementation.name}\` (${implementation.kind}, ${at(implementation.location)})${implementation.compatible ? "" : ": does not fit the contract"}`);
    }
    lines.push("", "### Tests", "");
    if (packet.tests.length === 0) lines.push("- none tagged");
    for (const file of packet.tests) {
      lines.push(`- ${file.file}`);
      for (const test of file.declarations) {
        const inactive = test.status === "active" ? "" : ` (inactive: ${test.inactiveBecause ?? test.status})`;
        lines.push(`  - line ${test.line}: "${[...test.suitePath, test.title].join(" > ")}" covers ${test.covers.length === 0 ? "nothing" : test.covers.map((id) => `\`${id}\``).join(", ")}${inactive}`);
      }
    }
    lines.push("", "### Dependencies", "");
    const named = (edges: { contract: string; module: string }[]) => (edges.length === 0 ? "none" : edges.map((edge) => `${edge.contract} (${edge.module})`).join(", "));
    lines.push(`- uses: ${named(packet.dependencies.uses)}`, `- used by: ${named(packet.dependencies.usedBy)}`, `- designs included: ${packet.dependencies.designs.length === 0 ? "none" : packet.dependencies.designs.join(", ")}`);
    lines.push("", "### Used outside the module", "");
    if (packet.usedBy.length === 0) lines.push("- nothing in the project imports an implementation of this contract from outside its module");
    for (const use of packet.usedBy) lines.push(`- ${use.file}:${use.line} imports ${use.names.join(", ")}${use.members.length > 0 ? ` and calls ${use.members.join(", ")}` : ""} — relies on the promises above; a change here reaches it`);
    lines.push("", "### Notes of the previous review", "");
    if (packet.priorNotes.length === 0) lines.push("- none recorded");
    for (const note of packet.priorNotes) lines.push(`- ${note}`);
    lines.push("", "### Fingerprinted dependencies", "");
    if (packet.fingerprinted.length === 0) lines.push("- none: the implementations and tests import no other local file");
    else lines.push(`- ${packet.fingerprinted.join(", ")} — a change in any of these makes the recorded review outdated`);
    lines.push("", "### Helpers loaded with the tests", "");
    if (packet.helpers.length === 0) lines.push("- none: the tests import nothing else from the project");
    for (const file of packet.helpers) lines.push(`- ${file}`);
    lines.push("", "### Tests without declarations", "");
    if (packet.untaggedTests.length === 0) lines.push("- none: every test file of the module declares something");
    for (const file of packet.untaggedTests) lines.push(`- ${file} (matched by the tests patterns, no \`@tests\` / \`@covers\`: proof there is not linked)`);
    lines.push("", "### Not loaded", "");
    if (packet.unloaded.length === 0) lines.push("- nothing: every project file the material imports is included");
    for (const { file, importedBy } of packet.unloaded) {
      lines.push(`- ${file}: ${importedBy.map((importer) => `${importer.names.join(", ")} for ${importer.file}`).join("; ")}`);
    }
    lines.push("", "### Diagnostics", "");
    if (packet.diagnostics.length === 0) lines.push("- none");
    for (const diagnostic of packet.diagnostics) lines.push(`- ${at(diagnostic) || "(project)"}: ${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message.replaceAll("\n", " ")}`);
    lines.push("");
  }

  lines.push("## Files", "");
  for (const file of report.files) {
    const language = file.path.endsWith(".mdx") ? "mdx" : "ts";
    // Every line is numbered, so that evidence can name a line without counting.
    const numbered = file.text.replace(/\n$/, "").split("\n");
    const width = String(numbered.length).length;
    lines.push(`### ${file.path} (${file.role})`, "", `${fence}${language}`, ...numbered.map((line, index) => `${String(index + 1).padStart(width)} | ${line}`), fence, "");
  }
  lines.push("## Result format", "", "Answer with one JSON object of this shape; `fingerprint` is copied from the contract's packet:", "", `${fence}json`, JSON.stringify(report.resultFormat, null, 2), fence, "");
  return `${lines.join("\n")}\n`;
}
