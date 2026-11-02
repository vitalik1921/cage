import fs from "node:fs";
import path from "node:path";
import { compareDiagnostics, hasErrors, type Diagnostic } from "./diagnostic.ts";
import { discoverDesigns } from "./discovery.ts";
import { createDraft, type DraftOptions } from "./draft.ts";
import { digestOf, draftPathOf, formatDraft, inspectPath, projectPathArgument } from "./draft-file.ts";
import { migrateContent, migrationDiff } from "./gherkin-migrate.ts";
import { toProjectPath } from "./location.ts";
import { formatDiagnostic } from "./report.ts";
import { loadTypeScript } from "./typescript.ts";

export interface MigrationFile {
  target: string; draft: string; rules: number;
  status: "unchanged" | "proposed" | "created" | "refused";
  diff: string | null;
}
export interface MigrationReport {
  schemaVersion: 1; command: "migrate"; format: "gherkin"; ok: boolean; dryRun: boolean;
  files: MigrationFile[]; diagnostics: Diagnostic[];
}

/** Preflight the whole selection, then create ordinary drafts exclusively; active files are never written. */
export function migrateGherkin(options: DraftOptions, modules: readonly string[], dryRun = false): MigrationReport {
  const root = path.resolve(options.root);
  const report: MigrationReport = { schemaVersion: 1, command: "migrate", format: "gherkin", ok: false, dryRun, files: [], diagnostics: [...options.problems] };
  const fail = (code: string, message: string, file?: string) => report.diagnostics.push({ code, severity: "error", message, ...(file ? { file } : {}) });
  if (hasErrors(report.diagnostics)) return report;
  const designs = discoverDesigns(root, options.config);
  const selected = designs.filter(design => modules.includes(design.moduleId));
  for (const module of modules) if (!selected.some(design => design.moduleId === module)) fail("E_MIGRATE", `no active designs in module ${module}`);
  if (hasErrors(report.diagnostics)) return report;
  const { ts } = loadTypeScript(root);
  const planned: { file: MigrationFile; source: string; content: string }[] = [];
  for (const design of selected) for (const absolute of design.sourceFiles) {
    const target = toProjectPath(root, absolute), draft = draftPathOf(target);
    const file: MigrationFile = { target, draft, rules: 0, status: "refused", diff: null };
    report.files.push(file);
    // Validate discovered paths too: the same header/path guarantees as cage draft create apply.
    const argument = projectPathArgument(target, ".cage.mdx");
    if (typeof argument !== "string") { fail("E_DRAFT", argument.problem, target); continue; }
    const targetState = inspectPath(root, target);
    if (targetState !== "file") { fail("E_DRAFT", typeof targetState === "object" ? targetState.problem : `${target} is missing`, target); continue; }
    let source: string;
    try { source = fs.readFileSync(absolute, "utf8"); }
    catch (cause) { fail("E_ENVIRONMENT", `cannot read the design: ${(cause as Error).message}`, target); continue; }
    const migrated = migrateContent(ts, source, target);
    report.diagnostics.push(...migrated.diagnostics);
    file.rules = migrated.rules.length;
    if (hasErrors(migrated.diagnostics)) continue;
    if (!migrated.rules.length) { file.status = "unchanged"; continue; }
    file.diff = dryRun ? migrationDiff(target, source, migrated.content) : null;
    const draftState = inspectPath(root, draft);
    if (typeof draftState === "object") { fail("E_DRAFT", draftState.problem, draft); continue; }
    if (draftState === "file") {
      try {
        if (fs.readFileSync(path.join(root, draft), "utf8") === formatDraft(target, digestOf(source), migrated.content)) { file.status = "unchanged"; continue; }
        fail("E_DRAFT_CONFLICT", `${draft} already exists with different content or a different base; it is not overwritten`, draft);
      } catch (cause) { fail("E_ENVIRONMENT", `cannot read the draft: ${(cause as Error).message}`, draft); }
      continue;
    }
    file.status = "proposed";
    planned.push({ file, source, content: migrated.content });
  }
  if (hasErrors(report.diagnostics)) {
    for (const { file } of planned) file.status = "refused";
  } else if (!dryRun) {
    for (const proposal of planned) {
      const created = createDraft(options, proposal.file.target, { source: proposal.source, content: proposal.content });
      proposal.file.status = created.status === "created" ? "created" : "refused";
      report.diagnostics.push(...created.diagnostics);
      if (!created.ok) {
        for (const later of planned) if (later.file.status === "proposed") later.file.status = "refused";
        break;
      }
    }
  }
  report.ok = !hasErrors(report.diagnostics);
  report.diagnostics.sort(compareDiagnostics);
  return report;
}

export function formatMigration(report: MigrationReport, project: readonly string[] = []): string {
  const quote = (word: string) => /^[\w./@:+=-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
  return [
    ...report.diagnostics.map(formatDiagnostic),
    `migrate gherkin: ${report.ok ? report.dryRun ? "preview" : "done" : "refused"}`,
    ...report.files.flatMap(file => [
      `  ${file.status}: ${file.target} → ${file.draft} (${file.rules} rules)`,
      ...(file.diff === null ? [] : [file.diff.trimEnd()]),
      ...(file.status === "created" || file.status === "unchanged" && file.rules > 0 ? [`  next: ${["cage", "draft", "check", file.draft, ...project].map(quote).join(" ")}`] : []),
    ]), "",
  ].join("\n");
}
