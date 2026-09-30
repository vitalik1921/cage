import path from "node:path";
import type { Contract, LockLevel, SourceLocation } from "./design-model.ts";
import type { DesignModule } from "./design-phase.ts";
import { compareDiagnostics, compareText, hasErrors, type Diagnostic } from "./diagnostic.ts";
import { checkImplementationPhase, type ImplementationPhaseOptions, type ImplementationPhaseResult } from "./implementation-phase.ts";
import { toProjectPath } from "./location.ts";
import { collectMaterial, createFileReader, fingerprintOf, type Material, type PacketFile } from "./review-material.ts";
import { readReviewFile, VERDICTS_SCHEMA } from "./review-record.ts";
import type { Overlay, TypeScript } from "./typescript.ts";

export type { PacketFile } from "./review-material.ts";

/** Everything the harness knows about one contract, with pointers into `files`. */
export interface ContractPacket {
  contract: string;
  module: string;
  /**
   * What the packet is made of: a digest of every file in it. It changes when
   * any of them changes, and a verdict is recorded against it.
   */
  fingerprint: string;
  /** The module's design document. */
  design: string;
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
  tests: { file: string; declarations: { title: string; suitePath: string[]; covers: string[]; line: number; column: number }[] }[];
  /** Project files that the packet's files import but that are not in the packet: the reviewer opens them in the repository. */
  unloaded: string[];
  /** What the check found about this contract or in its files. */
  diagnostics: Diagnostic[];
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
  "- Would the test fail if exactly this promise were broken?",
  "- Do the assertions observe the right result, order or effect?",
  "- Do mocks or stubs stand in for the very guarantee the test claims to check?",
  "- Are the relevant errors, boundaries, concurrency and retries considered?",
  "- Is an interface-level rule checked in the interaction of methods that it concerns?",
  "- Where there are several implementations, does each have the scenarios it needs?",
  "- Does the business description add material requirements, or contradict the invariants?",
  "",
  "Assess each invariant as `adequate`, `weak`, `unrelated` or `insufficient-context`, with a reason and the evidence (file and line) it rests on.",
  "This is an assessment, not a proof and not a test run. A contract without invariants gets one contract-level finding (invariant null).",
  "When you are the agent that wrote the code or the tests under review, judge them as a stranger would: the verdict is recorded and read by others.",
  "Do not remove or soften invariants and do not rewrite business requirements to make a check pass; a missing or weak test is a recommendation",
  "for the implementers, to be run in the project's own test environment. Files listed as not loaded were imported by the material but are not",
  "included: open them in the repository, or say that the context was insufficient.",
].join("\n");

/** What a verdict looks like; `design review --record` reads exactly this. */
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
 * `design review`: the material of the selected contracts for a reviewer,
 * human or model, with an instruction and the format of the verdict. Nothing
 * is sent anywhere; the report goes to stdout. It runs the full check first,
 * so that the structural diagnostics come with the material.
 */
export function runReview(options: ImplementationPhaseOptions, names: readonly string[] | "all" | "needed"): ReviewReport {
  const root = path.resolve(options.root);
  const result = checkImplementationPhase(options);
  const diagnostics = [...result.diagnostics];
  const complete = !hasErrors(diagnostics);
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
      return !recorded || recorded.fingerprint !== fingerprintOf(materialOf(contract.name).files).fingerprint;
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

  const packets = selected.map((contract) => packetOf(root, result, materialOf(contract.name)));
  const used = new Set(packets.flatMap((packet) => [packet.design, ...packet.dependencies.designs, ...packet.implementations.map((i) => i.location.file), ...packet.tests.map((t) => t.file)]));
  return report(ok, packets, [...files.values()].filter((file) => used.has(file.path)).sort((a, b) => compareText(a.path, b.path)));
}

function packetOf(root: string, result: ImplementationPhaseResult, material: Material): ContractPacket {
  const { modules, compiler, diagnostics } = result;
  const { contract, own, dependencyDesigns, uses, usedBy, implementations, declarations, testFiles, files } = material;
  const name = contract.name;
  const loaded = new Set(files.map((file) => file.path));
  const unloaded = compiler ? importsOutside(root, compiler.ts, compiler.overlay, modules, files, loaded) : [];

  const testsOf = (id: string) =>
    declarations
      .filter((test) => test.covers.includes(id))
      .map((test) => ({ file: test.location.file, line: test.location.line, column: test.location.column, title: test.title }));
  return {
    contract: name,
    module: contract.module,
    fingerprint: fingerprintOf(files).fingerprint,
    design: own.file,
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
        .map(({ title, suitePath, covers, location }) => ({ title, suitePath, covers, line: location.line, column: location.column })),
    })),
    unloaded,
    diagnostics: diagnostics.filter((diagnostic) => diagnostic.contract === name || (diagnostic.file !== undefined && loaded.has(diagnostic.file))).sort(compareDiagnostics),
  };
}

/**
 * Project files that the implementation and test files of a packet import
 * and that the packet does not hold: helpers, other modules. An import of a
 * generated design module stands for that module's design document.
 */
function importsOutside(
  root: string,
  ts: TypeScript,
  overlay: Pick<Overlay, "resolveFrom" | "sameFile">,
  modules: readonly DesignModule[],
  packetFiles: readonly PacketFile[],
  loaded: ReadonlySet<string>,
): string[] {
  const outside = new Set<string>();
  for (const file of packetFiles) {
    if (file.role === "design") continue;
    const fileName = path.join(root, file.path);
    const sourceFile = ts.createSourceFile(fileName, file.text, ts.ScriptTarget.Latest, false);
    for (const statement of sourceFile.statements) {
      const specifier = (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier;
      if (!specifier || !ts.isStringLiteral(specifier)) continue;
      const resolved = overlay.resolveFrom(specifier.text, fileName);
      if (!resolved) continue;
      const generated = modules.find((module) => overlay.sameFile(module.generatedFile, resolved));
      const projectPath = generated ? generated.file : toProjectPath(root, resolved);
      if (projectPath.startsWith("../") || path.isAbsolute(projectPath) || projectPath.split("/").includes("node_modules") || loaded.has(projectPath)) continue;
      outside.add(projectPath);
    }
  }
  return [...outside].sort(compareText);
}

/** The review as one Markdown document: the instruction, each contract, every file once, and the verdict format. */
export function formatReviewMarkdown(report: ReviewReport): string {
  const texts = [...report.files.map((file) => file.text), JSON.stringify(report.resultFormat, null, 2)];
  const longest = Math.max(2, ...texts.flatMap((text) => [...text.matchAll(/`+/g)].map((run) => run[0].length)));
  const fence = "`".repeat(longest + 1);
  const at = ({ file, line, column }: Partial<SourceLocation>) => [file, line, column].filter((part) => part !== undefined).join(":");
  const lines: string[] = ["# Design review", "", report.instruction, ""];
  if (!report.complete) lines.push("> The check found errors; they are listed with each contract. Part of the material below has been rejected by the harness.", "");
  if (report.contracts.length === 0) lines.push("No contract to review.", "");

  for (const packet of report.contracts) {
    lines.push(`## Contract ${packet.contract} (${packet.module})`, "");
    lines.push(`- Design: ${packet.design}`);
    lines.push(`- Fingerprint: ${packet.fingerprint}`);
    lines.push(`- Lock: ${packet.lock === null ? "none (open)" : `@${packet.lock}`}`);
    lines.push(`- Description: ${packet.description ?? "none"}`, "");
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
        lines.push(`  - line ${test.line}: "${[...test.suitePath, test.title].join(" > ")}" covers ${test.covers.length === 0 ? "nothing" : test.covers.map((id) => `\`${id}\``).join(", ")}`);
      }
    }
    lines.push("", "### Dependencies", "");
    const named = (edges: { contract: string; module: string }[]) => (edges.length === 0 ? "none" : edges.map((edge) => `${edge.contract} (${edge.module})`).join(", "));
    lines.push(`- uses: ${named(packet.dependencies.uses)}`, `- used by: ${named(packet.dependencies.usedBy)}`, `- designs included: ${packet.dependencies.designs.length === 0 ? "none" : packet.dependencies.designs.join(", ")}`);
    lines.push("", "### Not loaded", "");
    if (packet.unloaded.length === 0) lines.push("- nothing: every project file the material imports is included");
    for (const file of packet.unloaded) lines.push(`- ${file}`);
    lines.push("", "### Diagnostics", "");
    if (packet.diagnostics.length === 0) lines.push("- none");
    for (const diagnostic of packet.diagnostics) lines.push(`- ${at(diagnostic) || "(project)"}: ${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message.replaceAll("\n", " ")}`);
    lines.push("");
  }

  lines.push("## Files", "");
  for (const file of report.files) {
    const language = file.path.endsWith(".mdx") ? "mdx" : "ts";
    lines.push(`### ${file.path} (${file.role})`, "", `${fence}${language}`, file.text.replace(/\n$/, ""), fence, "");
  }
  lines.push("## Result format", "", "Answer with one JSON object of this shape; `fingerprint` is copied from the contract's packet:", "", `${fence}json`, JSON.stringify(report.resultFormat, null, 2), fence, "");
  return `${lines.join("\n")}\n`;
}
