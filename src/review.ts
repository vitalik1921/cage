import path from "node:path";
import type { Contract, LockLevel, SourceLocation, TestStatus } from "./design-model.ts";
import type { DesignModule } from "./design-phase.ts";
import { compareDiagnostics, compareText, hasErrors, type Diagnostic } from "./diagnostic.ts";
import { checkImplementationPhase, type ImplementationPhaseOptions, type ImplementationPhaseResult } from "./implementation-phase.ts";
import { toProjectPath } from "./location.ts";
import { collectMaterial, createFileReader, externalUses, fingerprintOf, type ExternalUse, type FileReader, type Material, type MaterialPart, type PacketFile } from "./review-material.ts";
import { ASSESSMENTS, countAssessments, findsFault, firstSentence, notesOf, readReviewFile, scopeDiagnostics, VERDICTS_SCHEMA, type Assessment, type Finding, type ReviewEntry } from "./review-record.ts";
import type { Overlay, TypeScript } from "./typescript.ts";

export type { PacketFile } from "./review-material.ts";

/** A part of the material that differs from the recorded review: changed since, new since, or gone. */
export interface ChangedPart {
  /** The part's key, as `.cage/review.json` records it. */
  part: string;
  kind: "contract" | "design" | "implementation" | "test" | "dependency";
  change: "changed" | "new" | "gone";
  file: string;
  line?: number;
  /** The implementation's name or the test's title. */
  name?: string;
}

/** What the recorded review found about an invariant, repeated so that a judgement of unchanged material can be confirmed or revised rather than made again. */
export type PriorFinding = Pick<Finding, "assessment" | "reason" | "evidence" | "suggestedChange">;

/** The lines of a file a changed part was taken from, numbered as in the file. */
export interface Excerpt {
  part: string;
  file: string;
  pieces: { startLine: number; endLine: number; text: string }[];
}

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
  /**
   * `touched`: whether the invariant's material changed since the recorded review — null when there is no outdated review to
   * compare with. `prior`: what that review found about it, if anything.
   */
  invariants: { id: string; text: string; member: string | null; location: SourceLocation; tests: { file: string; line: number; column: number; title: string }[]; touched: boolean | null; prior: PriorFinding[] }[];
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
  /** The parts of the material that differ from the recorded review; empty unless the review is outdated. */
  changed: ChangedPart[];
  /**
   * The invariants whose material changed since the recorded review: those a changed or new test covers, or all of them when the
   * contract, the prose, an implementation or a dependency changed, or a test is gone. Null when the review is not outdated.
   */
  touched: string[] | null;
  /** What the check found about this contract or in its files. */
  diagnostics: Diagnostic[];
  /**
   * What `.cage/review.json` holds for the contract: no verdict, a verdict for
   * other material, one for this material with the count of each assessment
   * (of the invariants, and of the contract as a whole apart), an acceptance
   * of this material without a review (`cage review --accept`), or "unknown"
   * when the file cannot be used. A verdict is a reviewer's assessment, not a
   * proof and not a test run; an acceptance is not even that.
   */
  recordedReview: {
    status: "none" | "outdated" | "current" | "accepted" | "unknown";
    assessments: Record<Assessment, number> | null;
    contractAssessments: Record<Assessment, number> | null;
  };
}

/** How much of the material's text a packet carries; the skeleton always refers to every file by path and line. */
export type Included = "all" | "changed" | "none";

export interface ReviewReport {
  schemaVersion: 1;
  command: "review";
  /** Whether the packets could be made: every named contract exists and the designs were indexed. */
  ok: boolean;
  /** False when the check found errors: the reviewer sees material that the harness has already rejected in part. */
  complete: boolean;
  selection: "named";
  /**
   * "changed" (the default): for a contract with an outdated review, the lines of the parts that changed (`excerpts`) and
   * whole only the documents and dependency files that changed; for any other contract every file, as "all". "none": no text,
   * the reviewer opens the files named in the skeleton.
   */
  included: Included;
  instruction: string;
  resultFormat: typeof RESULT_FORMAT;
  /** The same as a JSON Schema, for a reviewer that can be held to one. */
  resultSchema: typeof VERDICTS_SCHEMA;
  contracts: ContractPacket[];
  files: PacketFile[];
  excerpts: Excerpt[];
  diagnostics: Diagnostic[];
}

/** One line of the index: what `cage review` without names says about a contract. */
export interface ReviewIndexEntry {
  contract: string;
  module: string;
  fingerprint: string;
  status: ContractPacket["recordedReview"]["status"];
  invariants: string[];
  touched: string[] | null;
  changed: ChangedPart[];
  /** Files of the material: the module's designs, the designs it depends on, the implementations and the test files. */
  files: number;
  /** What the check found about the contract. */
  errors: number;
  warnings: number;
  /** The codes of those findings, each once. */
  codes: string[];
}

/**
 * `cage review` without names: an index of the contracts, not their material — which need a review, what changed and
 * which invariants it touches — for a reviewer who then takes one contract at a time with `cage review <Name>`.
 */
export interface ReviewIndex {
  schemaVersion: 1;
  command: "review";
  /** Whether the index could be made: the designs were indexed. */
  ok: boolean;
  complete: boolean;
  /** "needed": the contracts without a record of their current material; the default. "all": every contract, with its status. */
  selection: "all" | "needed";
  contracts: ReviewIndexEntry[];
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
  "When the recorded review is outdated, the packet names what changed since it and which invariants that touches, and repeats the previous",
  "finding of each invariant: judge the touched ones afresh; for the others, confirm the previous finding or revise it — a verdict is",
  "complete only with every invariant. The files are named with their lines wherever the packet does not carry their text: open them in the",
  "repository.",
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

/** What the commands of `review` share: the full check, a file reader, the review file, and the material of each contract once. */
function prepare(options: ImplementationPhaseOptions) {
  const root = path.resolve(options.root);
  const result = checkImplementationPhase(options);
  const diagnostics = [...result.diagnostics];
  const { read, files } = createFileReader(root, diagnostics, result.linking?.sources);
  const materials = new Map<string, Material>();
  const materialOf = (name: string) => {
    if (!materials.has(name)) materials.set(name, collectMaterial(result, name, read));
    return materials.get(name)!;
  };
  // Without a usable review file nothing is recorded for anyone; its problem is reported once.
  const reviews = readReviewFile(root);
  diagnostics.push(...reviews.diagnostics);
  const priorOf = (contract: Contract) => reviews.entries.find((entry) => entry.module === contract.module && entry.contract === contract.name);
  return { root, result, diagnostics, read, files, materialOf, reviews, priorOf };
}

/**
 * `cage review <Name…>`: the material of the named contracts for a reviewer,
 * human or model, with an instruction and the format of the verdict. Nothing
 * is sent anywhere; the report goes to stdout. It runs the full check first,
 * so that the structural diagnostics come with the material. `included` says
 * how much text comes along: by default the lines that changed since the
 * recorded review, or everything when there is no review to compare with.
 */
export function runReview(options: ImplementationPhaseOptions, names: readonly string[], included: Included = "changed"): ReviewReport {
  const { root, result, diagnostics, read, files, materialOf, reviews, priorOf } = prepare(options);
  let complete = !hasErrors(diagnostics);
  const report = (ok: boolean, contracts: ContractPacket[], packetFiles: PacketFile[], excerpts: Excerpt[]): ReviewReport => ({
    schemaVersion: 1,
    command: "review",
    ok,
    complete,
    selection: "named",
    included,
    instruction: INSTRUCTION,
    resultFormat: RESULT_FORMAT,
    resultSchema: VERDICTS_SCHEMA,
    contracts,
    files: packetFiles,
    excerpts,
    diagnostics: diagnostics.sort(compareDiagnostics),
  });
  const { index } = result;
  if (!index) return report(false, [], [], []);

  let ok = true;
  const selected: Contract[] = [];
  for (const name of names) {
    const contract = index.contracts.find((candidate) => candidate.name === name);
    if (contract) {
      if (!selected.includes(contract)) selected.push(contract);
    } else {
      ok = false;
      diagnostics.push({ code: "E_REFERENCE_UNKNOWN", severity: "error", message: `no contract "${name}"` });
    }
  }
  selected.sort((a, b) => compareText(a.module, b.module) || compareText(a.name, b.name));

  const packets = selected.map((contract) => packetOf(root, result, diagnostics, materialOf(contract.name), options.sources.tests, options.sources.implementations, read, reviews.diagnostics.length > 0, priorOf(contract)));
  // A file of the material that could not be read leaves a packet with a hole: the export is not complete.
  if (packets.some((packet) => packet.diagnostics.some((diagnostic) => diagnostic.code === "E_ENVIRONMENT"))) complete = false;
  const whole = new Set<string>();
  const excerpts: Excerpt[] = [];
  for (const packet of packets) {
    const material = materialOf(packet.contract);
    const everything = [...packet.designs, ...packet.dependencies.designs, ...packet.implementations.map((i) => i.location.file), ...packet.tests.map((t) => t.file), ...packet.helpers, ...packet.fingerprinted];
    if (included === "none") continue;
    // Only an outdated review has something to compare with; otherwise the reviewer reads everything. So does one whose
    // parts all match by digest and whose fingerprint still differs (the parts in another order, or the record edited).
    if (included === "all" || packet.recordedReview.status !== "outdated" || packet.changed.length === 0) {
      for (const file of everything) whole.add(file);
      continue;
    }
    for (const change of packet.changed) {
      if (change.change === "gone") continue;
      const part = material.parts.find((candidate) => candidate.key === change.part);
      if (!part) continue;
      if (part.pieces) {
        // A dependency used only to establish inert initialization can have no selected lines.
        if (part.pieces.length === 0) continue;
        const text = files.get(part.file)?.text;
        if (text !== undefined) excerpts.push({ part: part.key, file: part.file, pieces: part.pieces.map((piece) => ({ ...piece, text: linesOf(text, piece.startLine, piece.endLine) })) });
        else whole.add(part.file);
      } else if (change.kind === "dependency") {
        // Fingerprinted, not loaded: the text is the part's, taken as a whole file.
        if (read(part.file, "dependency", part.text)) whole.add(part.file);
      } else {
        whole.add(part.file);
      }
    }
  }
  // A file another packet of this report holds is in the document; it is not "not loaded" for anyone.
  for (const packet of packets) packet.unloaded = packet.unloaded.filter((entry) => !whole.has(entry.file));
  return report(ok, packets, [...files.values()].filter((file) => whole.has(file.path)).sort((a, b) => compareText(a.path, b.path)), excerpts);
}

/** Lines `from` to `to` of a text, 1-based and inclusive, without the final line break. */
function linesOf(text: string, from: number, to: number): string {
  return text.split("\n").slice(from - 1, to).join("\n");
}

/**
 * `cage review` without names: the index. For every contract — those without a record of their material as it is now,
 * or all of them — its status, what changed since the recorded review and which invariants that touches, so that a
 * reviewer takes one contract at a time with `cage review <Name>`.
 */
export function runReviewIndex(options: ImplementationPhaseOptions, selection: "all" | "needed"): ReviewIndex {
  const { result, diagnostics, materialOf, reviews, priorOf } = prepare(options);
  const { index } = result;
  const report = (contracts: ReviewIndexEntry[]): ReviewIndex => ({
    schemaVersion: 1,
    command: "review",
    ok: index !== null,
    complete: !hasErrors(diagnostics),
    selection,
    contracts,
    diagnostics: diagnostics.sort(compareDiagnostics),
  });
  if (!index) return report([]);
  const entries: ReviewIndexEntry[] = [];
  for (const contract of [...index.contracts].sort((a, b) => compareText(a.module, b.module) || compareText(a.name, b.name))) {
    const material = materialOf(contract.name);
    // A dependency that cannot be read is a hole of unknown size and is said; the bounds of the scope are not: they are the
    // project's setting, reported by `check`, and a reviewer is not to be sent to the configuration.
    diagnostics.push(...scopeDiagnostics(material, "warn").filter((diagnostic) => diagnostic.code === "E_ENVIRONMENT" && !diagnostics.some((known) => known.code === diagnostic.code && known.contract === diagnostic.contract && known.file === diagnostic.file)));
    const { fingerprint, digests } = fingerprintOf(material.parts);
    const prior = priorOf(contract);
    const { status } = recordedReviewOf(reviews.diagnostics.length > 0, prior, fingerprint);
    if (selection === "needed" && status !== "none" && status !== "outdated" && status !== "unknown") continue;
    const invariants = index.invariants.filter((invariant) => invariant.contract === contract.name).map((invariant) => invariant.id);
    const changed = status === "outdated" && prior ? changesOf(material, digests, prior) : [];
    const about = diagnostics.filter((diagnostic) => diagnostic.contract === contract.name);
    entries.push({
      contract: contract.name,
      module: contract.module,
      fingerprint,
      status,
      invariants,
      touched: status === "outdated" && prior ? touchedBy(material, changed, invariants, prior) : null,
      changed,
      files: material.files.length,
      errors: about.filter((diagnostic) => diagnostic.severity === "error").length,
      warnings: about.filter((diagnostic) => diagnostic.severity === "warning").length,
      codes: [...new Set(about.map((diagnostic) => diagnostic.code))],
    });
  }
  return report(entries);
}

/** The parts of the material that differ from a recorded review, in the order of the material; what the record has and the material no longer does comes last. */
function changesOf(material: Material, digests: Record<string, string>, prior: ReviewEntry): ChangedPart[] {
  const describe = (part: MaterialPart, change: ChangedPart["change"]): ChangedPart => ({ part: part.key, kind: kindOf(part.key), change, file: part.file, ...(part.line === undefined ? {} : { line: part.line }), ...(part.name === undefined ? {} : { name: part.name }) });
  const changes = material.parts.filter((part) => !Object.hasOwn(prior.material, part.key) || prior.material[part.key] !== digests[part.key]).map((part) => describe(part, Object.hasOwn(prior.material, part.key) ? "changed" : "new"));
  const keys = new Set(material.parts.map((part) => part.key));
  for (const key of Object.keys(prior.material)) if (!keys.has(key)) changes.push({ ...goneOf(key, material), change: "gone" });
  return changes;
}

function kindOf(key: string): ChangedPart["kind"] {
  const kind = /^(design|implementation|test|dependency) /.exec(key)?.[1];
  return (kind as ChangedPart["kind"] | undefined) ?? "contract";
}

/** A part the record has but the material no longer does, from its key alone: the file, and the name or title the key holds. */
function goneOf(key: string, material: Material): Omit<ChangedPart, "change"> {
  const kind = kindOf(key);
  if (kind === "contract") return { part: key, kind, file: material.contract.location.file };
  const rest = key.slice(kind.length + 1);
  if (kind === "implementation") {
    const at = rest.lastIndexOf("#");
    return { part: key, kind, file: rest.slice(0, at), name: rest.slice(at + 1) };
  }
  if (kind === "test") {
    const at = rest.indexOf(":");
    return { part: key, kind, file: rest.slice(0, at), name: rest.slice(at + 1) };
  }
  return { part: key, kind, file: rest };
}

/**
 * The invariants a set of changes touches: those the changed or new tests cover now; those whose previous finding rests,
 * by its evidence, on the lines of a changed test — a test re-tagged away from an invariant has changed, and the finding
 * cited it; those with a previous finding and no linked test any more; and all of them when anything but a test changed,
 * a test is gone (what it covered is not known any more), or no part differs by its digest while the fingerprint does
 * (the parts in another order, or the record edited: nothing can be told apart).
 */
function touchedBy(material: Material, changes: readonly ChangedPart[], invariants: readonly string[], prior: ReviewEntry): string[] {
  if (changes.length === 0 || changes.some((change) => change.kind !== "test" || change.change === "gone")) return [...invariants];
  const changedParts = changes.map((change) => material.parts.find((part) => part.key === change.part)).filter((part): part is MaterialPart => part !== undefined);
  const covered = new Set(changedParts.flatMap((part) => part.covers ?? []));
  const restsOnChanged = (finding: Finding) => evidenceRefs(finding.evidence).some((ref) => changedParts.some((part) => part.file === ref.file && (part.pieces ?? []).some((piece) => ref.from <= piece.endLine && ref.to >= piece.startLine)));
  const linkedNow = (id: string) => material.declarations.some((declaration) => declaration.covers.includes(id));
  return invariants.filter((id) => covered.has(id) || prior.findings.some((finding) => finding.invariant === id && (restsOnChanged(finding) || !linkedNow(id))));
}

/** The `file:line` and `file:line-line` references an evidence text names, as the reviewer wrote them (project-relative paths). */
function evidenceRefs(evidence: string | null): { file: string; from: number; to: number }[] {
  if (!evidence) return [];
  return [...evidence.matchAll(/([^\s;,()"'`]+):(\d+)(?:[-–](\d+))?/g)].map((match) => ({ file: match[1], from: Number(match[2]), to: Number(match[3] ?? match[2]) }));
}

function packetOf(
  root: string,
  result: ImplementationPhaseResult,
  diagnostics: Diagnostic[],
  material: Material,
  testFiles_: readonly string[],
  sourceFiles: readonly string[],
  read: FileReader,
  reviewsUnusable: boolean,
  prior: ReviewEntry | undefined,
): ContractPacket {
  const { compiler } = result;
  const { contract, own, dependencyDesigns, uses, usedBy, implementations, declarations, testFiles, files } = material;
  // A dependency that cannot be read leaves a hole in the packet and is said. The bounds of the fingerprint are not said here:
  // they are the project's `reviewDependencies` setting, reported by `check`; a packet that named them would send the reviewer
  // to the configuration instead of the material. The fingerprinted files are listed, so what is covered is in view.
  diagnostics.push(...scopeDiagnostics(material, "warn").filter((diagnostic) => diagnostic.code === "E_ENVIRONMENT" && !diagnostics.some((known) => known.code === diagnostic.code && known.contract === diagnostic.contract && known.file === diagnostic.file)));
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
  const { fingerprint, digests } = fingerprintOf(material.parts);
  const recordedReview = recordedReviewOf(reviewsUnusable, prior, fingerprint);
  const priorNotes = prior ? notesOf(prior.findings) : [];
  const declaring = new Set((result.linking?.tests ?? []).map((test) => test.location.file));
  const inModule = (file: string) => contract.module === "." || file.startsWith(`${contract.module}/`);
  const untaggedTests = testFiles_.filter((file) => inModule(file) && !declaring.has(file)).sort(compareText);
  const ids = result.index!.invariants.filter((invariant) => invariant.contract === name).map((invariant) => invariant.id);
  const changed = recordedReview.status === "outdated" && prior ? changesOf(material, digests, prior) : [];
  const touched = recordedReview.status === "outdated" && prior ? touchedBy(material, changed, ids, prior) : null;
  const priorOf = (id: string): PriorFinding[] => (prior?.findings ?? []).filter((finding) => finding.invariant === id).map(({ assessment, reason, evidence, suggestedChange }) => ({ assessment, reason, evidence, suggestedChange }));

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
    invariants: result.index!.invariants.filter((invariant) => invariant.contract === name).map(({ id, text, member, location }) => ({ id, text, member, location, tests: testsOf(id), touched: touched === null ? null : touched.includes(id), prior: priorOf(id) })),
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
    changed,
    touched,
    // What the checks say about the files a reviewer reads belongs here; what is said about another contract's review does not.
    diagnostics: diagnostics
      .filter((diagnostic) => diagnostic.contract === name || (diagnostic.file !== undefined && (loaded.has(diagnostic.file) || attempted.has(diagnostic.file)) && !(diagnostic.contract !== undefined && diagnostic.code.includes("REVIEW_"))))
      .sort(compareDiagnostics),
    recordedReview,
  };
}

function recordedReviewOf(unusable: boolean, prior: ReviewEntry | undefined, fingerprint: string): ContractPacket["recordedReview"] {
  if (unusable) return { status: "unknown", assessments: null, contractAssessments: null };
  if (!prior) return { status: "none", assessments: null, contractAssessments: null };
  if (prior.fingerprint !== fingerprint) return { status: "outdated", assessments: null, contractAssessments: null };
  if (prior.accepted) return { status: "accepted", assessments: null, contractAssessments: null };
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

/** A changed part in one line: what it is, where, and what happened to it. */
function describeChange(change: ChangedPart): string {
  const where = change.line === undefined ? change.file : `${change.file}:${change.line}`;
  const what = change.kind === "contract" ? "the contract declaration" : change.kind === "design" ? "the prose of the design" : change.kind === "implementation" ? `implementation ${change.name}` : change.kind === "test" ? `test "${change.name}"` : "dependency";
  return `${what} ${change.change} (${where})`;
}

/** The lines of an excerpt with their numbers, pieces apart. */
function numberedPieces(excerpt: Excerpt): string[] {
  const width = String(Math.max(...excerpt.pieces.map((piece) => piece.endLine))).length;
  return excerpt.pieces.flatMap((piece, order) => [...(order === 0 ? [] : [`${" ".repeat(width)} ⋮`]), ...piece.text.split("\n").map((line, offset) => `${String(piece.startLine + offset).padStart(width)} | ${line}`)]);
}

/** A diagnostic in one line of a packet or the index: the code, the thing, the place. */
function diagnosticLine(diagnostic: Diagnostic): string {
  const place = [diagnostic.file, diagnostic.line, diagnostic.column].filter((part) => part !== undefined).join(":");
  return `${diagnostic.code} ${diagnostic.message.split("\n")[0]}${place === "" ? "" : ` (${place})`}`;
}

/** The recorded review of a packet in one line. */
function recordedLine(packet: ContractPacket): string {
  const { status, assessments, contractAssessments } = packet.recordedReview;
  if (status === "none") return "none";
  if (status === "unknown") return "not known (the review file cannot be used)";
  if (status === "accepted") return "accepted without a review";
  if (status === "outdated") {
    if (packet.changed.length === 0) return "outdated: no part differs, the fingerprint does (reordered, or the record edited)";
    const touched = packet.touched ?? [];
    const scope = packet.invariants.length === 0 ? "" : touched.length === packet.invariants.length ? ", touching every invariant" : `, touching ${touched.length} of ${packet.invariants.length} invariants`;
    return `outdated, ${packet.changed.length} ${packet.changed.length === 1 ? "part" : "parts"} changed${scope}`;
  }
  const listed = (counts: Record<Assessment, number>) => ASSESSMENTS.filter((assessment) => counts[assessment] > 0).map((assessment) => `${counts[assessment]} ${assessment}`).join(", ");
  const invariants = assessments ? listed(assessments) : "";
  const whole = contractAssessments && (findsFault(contractAssessments) || invariants === "") ? `the contract as a whole: ${listed(contractAssessments) || "no finding"}` : "";
  return `current: ${[invariants, whole].filter((part) => part !== "").join("; ")}`;
}

/** The verdict template for the packets of a report, with the fingerprints filled in: what `cage review --record` reads. */
function verdictTemplate(contracts: readonly ContractPacket[]): string {
  const finding = { invariant: "<id, or null for the contract as a whole>", assessment: "adequate | weak | unrelated | insufficient-context", reason: "<why>", evidence: "<file:line; null only for insufficient-context>", suggestedChange: "<what to change, or null>" };
  return JSON.stringify({ version: 1, verdicts: contracts.map((packet) => ({ contract: packet.contract, fingerprint: packet.fingerprint, findings: [finding] })) });
}

/**
 * The packets as one Markdown document: per contract its facts, invariants with the previous findings, code, and
 * the text that comes along; at the end the verdict template. The reviewer's instruction is the `cage-review` skill's
 * and the reference's, not the packet's.
 */
export function formatReviewMarkdown(report: ReviewReport): string {
  const texts = [...report.files.map((file) => file.text), ...report.excerpts.flatMap((excerpt) => excerpt.pieces.map((piece) => piece.text))];
  const longest = Math.max(2, ...texts.flatMap((text) => [...text.matchAll(/`+/g)].map((run) => run[0].length)));
  const fence = "`".repeat(longest + 1);
  const at = ({ file, line }: Partial<SourceLocation>) => [file, line].filter((part) => part !== undefined).join(":");
  const lines: string[] = [];
  if (!report.complete) lines.push("> The check found errors; part of the material has been rejected by the harness. They are listed with each contract.", "");
  if (report.contracts.length === 0) lines.push("No contract to review.", "");

  for (const packet of report.contracts) {
    const declarations = packet.tests.flatMap((file) => file.declarations);
    const inactive = declarations.filter((test) => test.status !== "active").length;
    lines.push(`# ${packet.contract} (${packet.module})`);
    lines.push(`fingerprint: ${packet.fingerprint}`);
    lines.push(`design: ${packet.designs.join(", ")}${packet.dependencies.designs.length > 0 ? `; uses ${packet.dependencies.designs.join(", ")}` : ""}`);
    if (packet.description) lines.push(`description: ${packet.description}`);
    if (packet.lock) lines.push(`lock: @${packet.lock}`);
    lines.push(`review: ${recordedLine(packet)}`);
    lines.push(`tests: ${declarations.length === 0 ? "none tagged" : inactive === 0 ? `all ${declarations.length} active` : `${inactive} of ${declarations.length} inactive (skipped, todo, empty or a broken import); not run by cage`}`);
    if (packet.diagnostics.length > 0) lines.push(`check: ${packet.diagnostics.map(diagnosticLine).join("; ")}`);
    lines.push("");

    if (packet.recordedReview.status === "outdated") {
      lines.push("## Changed");
      if (packet.changed.length === 0) lines.push("- no part differs by its digest; every file is included, judge every invariant afresh");
      for (const change of packet.changed) lines.push(`- ${describeChange(change)}`);
      const touched = packet.touched ?? [];
      const rest = packet.invariants.map(({ id }) => id).filter((id) => !touched.includes(id));
      if (packet.invariants.length > 0 && packet.changed.length > 0) lines.push(`touches: ${touched.length === 0 ? "no invariant's tests" : touched.join(", ")}${touched.length > 0 ? " (judge afresh)" : ""}${rest.length > 0 ? `; ${rest.join(", ")} (confirm or revise)` : ""}`);
      lines.push("");
    }

    lines.push("## Invariants");
    if (packet.invariants.length === 0) lines.push("- none: assess the contract as a whole");
    for (const invariant of packet.invariants) {
      lines.push(`- ${invariant.id}${invariant.member ? ` on ${invariant.member}` : ""} (${at(invariant.location)}): ${invariant.text}`);
      lines.push(`  tests: ${invariant.tests.length === 0 ? "none" : invariant.tests.map((test) => `${test.file}:${test.line} "${test.title}"`).join("; ")}`);
      for (const finding of invariant.prior) {
        const stands = invariant.touched === null ? "" : invariant.touched ? ", changed" : ", unchanged";
        lines.push(`  recorded: ${finding.assessment}, "${firstSentence(finding.reason)}"${finding.evidence ? ` (${finding.evidence})` : ""}${stands}`);
      }
    }
    lines.push("");

    lines.push("## Code");
    if (packet.implementations.length === 0) lines.push("- none tagged");
    for (const implementation of packet.implementations) lines.push(`- ${implementation.name} (${implementation.kind}, ${at(implementation.location)})${implementation.compatible ? "" : ": does not fit the contract"}`);
    if (packet.members.length > 0) lines.push(`- members: ${packet.members.map((member) => `${member.name}${member.description ? ` (${member.description})` : ""}`).join(", ")}`);
    for (const file of packet.tests) {
      const inactiveHere = file.declarations.filter((test) => test.status !== "active");
      lines.push(`- tests: ${file.file}${inactiveHere.length > 0 ? `; inactive: ${inactiveHere.map((test) => `"${test.title}" ${test.inactiveBecause ?? test.status} (line ${test.line})`).join(", ")}` : ""}`);
    }
    if (packet.fingerprinted.length > 0) lines.push(`- fingerprinted: ${packet.fingerprinted.join(", ")}`);
    if (packet.helpers.length > 0) lines.push(`- test helpers: ${packet.helpers.join(", ")}`);
    if (packet.dependencies.uses.length > 0) lines.push(`- uses: ${packet.dependencies.uses.map((edge) => `${edge.contract} (${edge.module})`).join(", ")}`);
    if (packet.dependencies.usedBy.length > 0) lines.push(`- used by: ${packet.dependencies.usedBy.map((edge) => `${edge.contract} (${edge.module})`).join(", ")}`);
    for (const use of packet.usedBy) lines.push(`- used outside the module: ${use.file}:${use.line} imports ${use.names.join(", ")}${use.members.length > 0 ? `, calls ${use.members.join(", ")}` : ""}`);
    for (const note of packet.priorNotes) lines.push(`- previous review note: ${note}`);
    for (const file of packet.untaggedTests) lines.push(`- test file without tags: ${file}`);
    for (const { file, importedBy } of packet.unloaded) lines.push(`- not loaded: ${file} (${importedBy.map((importer) => `${importer.names.join(", ")} for ${importer.file}`).join("; ")})`);
    lines.push("");
  }

  if (report.excerpts.length > 0) {
    lines.push("## Changed material", "");
    for (const excerpt of report.excerpts) {
      const ranges = excerpt.pieces.map((piece) => (piece.startLine === piece.endLine ? `${piece.startLine}` : `${piece.startLine}-${piece.endLine}`)).join(", ");
      lines.push(`### ${excerpt.file}:${ranges}`, `${fence}ts`, ...numberedPieces(excerpt), fence, "");
    }
  }
  if (report.files.length > 0) {
    lines.push("## Files", "");
    for (const file of report.files) {
      const language = file.path.endsWith(".mdx") ? "mdx" : "ts";
      // Every line is numbered, so that evidence can name a line without counting.
      const numbered = file.text.replace(/\n$/, "").split("\n");
      const width = String(numbered.length).length;
      lines.push(`### ${file.path} (${file.role})`, `${fence}${language}`, ...numbered.map((line, index) => `${String(index + 1).padStart(width)} | ${line}`), fence, "");
    }
  }
  if (report.contracts.length > 0) lines.push("## Verdict", "`cage review --record <file>` reads this shape, one finding per invariant:", verdictTemplate(report.contracts), "");
  return `${lines.join("\n")}\n`;
}

/** The index as Markdown: one entry per contract, its status and what changed. */
export function formatReviewIndexMarkdown(report: ReviewIndex): string {
  const lines: string[] = [];
  if (!report.ok) {
    lines.push("# Review index: the designs could not be indexed", "");
    for (const diagnostic of report.diagnostics) lines.push(`- ${diagnosticLine(diagnostic)}`);
    return `${lines.join("\n")}\n`;
  }
  const needing = report.contracts.filter((entry) => entry.status === "none" || entry.status === "outdated" || entry.status === "unknown").length;
  const head = report.selection === "needed" ? (needing === 0 ? "no contract needs a review" : `${needing} ${needing === 1 ? "contract needs" : "contracts need"} a review`) : `${report.contracts.length} contracts, ${needing} in need of a review`;
  lines.push(`# Review index: ${head}`, "");
  const describeStatus = (entry: ReviewIndexEntry) => {
    if (entry.status === "none") return "no review";
    if (entry.status === "unknown") return "not known (the review file cannot be used)";
    if (entry.status === "accepted") return "accepted without a review";
    if (entry.status === "current") return "reviewed, current";
    if (entry.changed.length === 0) return "outdated: no part differs, the fingerprint does";
    const touched = entry.touched ?? [];
    const scope = entry.invariants.length === 0 ? "" : touched.length === entry.invariants.length ? ", touching every invariant" : touched.length === 0 ? ", touching no invariant's tests" : `, touching ${touched.join(", ")}`;
    return `outdated, ${entry.changed.length} ${entry.changed.length === 1 ? "part" : "parts"} changed${scope}`;
  };
  for (const entry of report.contracts) {
    lines.push(`- ${entry.contract} (${entry.module}): ${describeStatus(entry)}; ${entry.invariants.length} ${entry.invariants.length === 1 ? "invariant" : "invariants"}, ${entry.files} ${entry.files === 1 ? "file" : "files"}${entry.codes.length > 0 ? `; ${entry.codes.join(", ")}` : ""}`);
    const shown = entry.changed.slice(0, 8);
    for (const change of shown) lines.push(`  - ${describeChange(change)}`);
    if (entry.changed.length > shown.length) lines.push(`  - and ${entry.changed.length - shown.length} more`);
  }
  // An entry carries its contract's codes; every error, and what is about no listed contract, is said in full.
  const standing = report.diagnostics.filter((diagnostic) => diagnostic.severity === "error" || !report.contracts.some((entry) => entry.contract === diagnostic.contract));
  if (standing.length > 0) lines.push("", ...standing.map((diagnostic) => `- ${diagnosticLine(diagnostic)}`));
  return `${lines.join("\n")}\n`;
}
