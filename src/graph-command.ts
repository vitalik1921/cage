import { checkDesignPhase, type DesignPhaseOptions } from "./design-phase.ts";
import type { DesignIndex, SourceLocation } from "./design-model.ts";
import { compareText, hasErrors, type Diagnostic } from "./diagnostic.ts";
import { formatDiagnostic } from "./report.ts";

export interface GraphNode { id: string; kind: "contract" | "family" | "data" | "module"; name: string; module: string }
export interface GraphEdge { kind: "uses" | "extends" | "type-import"; from: string; to: string; location: SourceLocation }
export interface GraphQuery { name?: string; usedBy?: boolean; depth?: number }
export interface GraphReport {
  schemaVersion: 1; command: "graph"; ok: boolean;
  focus: string | null; direction: "dependencies" | "used-by"; depth: number | null;
  nodes: GraphNode[] | null; edges: GraphEdge[] | null; diagnostics: Diagnostic[];
}
const contractId = (name: string) => `contract:${name}`;
const moduleId = (module: string) => `module:${module}`;
const dataId = (module: string, name: string) => `data:${module}#${name}`;

/** Declared edges only: imports remain module-level, separate from the named contract/family graph. */
export function runGraph(options: DesignPhaseOptions, query: GraphQuery): GraphReport {
  const result = checkDesignPhase(options);
  const report: GraphReport = { schemaVersion: 1, command: "graph", ok: false, focus: query.name ?? null, direction: query.usedBy ? "used-by" : "dependencies", depth: query.depth ?? null, nodes: null, edges: null, diagnostics: [...result.diagnostics] };
  if (!result.index || hasErrors(result.diagnostics)) return report;
  const focus = query.name === undefined ? undefined : result.index.contracts.find(contract => contract.name === query.name);
  if (query.name !== undefined && !focus) {
    report.diagnostics.push({ code: "E_REFERENCE_UNKNOWN", severity: "error", message: `graph: no contract or family named ${query.name}` });
    return report;
  }
  const graph = designGraph(result.index, options.designs.map(design => design.moduleId));
  if (focus) {
    const selected = reachable(graph.edges, [contractId(focus.name), moduleId(focus.module)], query.usedBy ?? false, query.depth ?? Infinity);
    report.nodes = graph.nodes.filter(node => selected.nodes.has(node.id));
    report.edges = graph.edges.filter(edge => selected.edges.has(edge));
  } else {
    report.nodes = graph.nodes;
    report.edges = graph.edges;
  }
  report.ok = true;
  return report;
}

function designGraph(index: DesignIndex, modules: string[]): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [
    ...modules.map(module => ({ id: moduleId(module), kind: "module" as const, name: module, module })),
    ...index.contracts.map(contract => ({ id: contractId(contract.name), kind: contract.family ? "family" as const : "contract" as const, name: contract.name, module: contract.module })),
    ...index.data.map(data => ({ id: dataId(data.module, data.name), kind: "data" as const, name: data.name, module: data.module })),
  ];
  const edges: GraphEdge[] = index.edges.map(edge => ({
    kind: edge.kind,
    from: edge.kind === "type-import" ? moduleId(edge.fromModule) : contractId(edge.from),
    to: edge.kind === "type-import" ? moduleId(edge.toModule) : edge.kind === "extends" && edge.toKind === "data" ? dataId(edge.toModule, edge.to) : contractId(edge.to),
    location: edge.location,
  }));
  nodes.sort((a, b) => compareText(a.id, b.id));
  edges.sort((a, b) => compareText(a.from, b.from) || compareText(a.to, b.to) || compareText(a.kind, b.kind) || compareText(a.location.file, b.location.file) || a.location.line - b.location.line || a.location.column - b.location.column);
  return { nodes, edges };
}

function reachable(edges: GraphEdge[], roots: string[], reverse: boolean, depth: number): { nodes: Set<string>; edges: Set<GraphEdge> } {
  const nodes = new Set(roots), selected = new Set<GraphEdge>();
  const queue = roots.map(id => ({ id, level: 0 }));
  for (let i = 0; i < queue.length; i++) {
    const { id, level } = queue[i];
    if (level >= depth) continue;
    for (const edge of edges) {
      if ((reverse ? edge.to : edge.from) !== id) continue;
      selected.add(edge);
      const next = reverse ? edge.from : edge.to;
      if (!nodes.has(next)) { nodes.add(next); queue.push({ id: next, level: level + 1 }); }
    }
  }
  return { nodes, edges: selected };
}

export function formatGraph(report: GraphReport, format: "text" | "mermaid"): string {
  const nodes = report.nodes ?? [], edges = report.edges ?? [];
  if (format === "mermaid") {
    const ids = new Map(nodes.map((node, index) => [node.id, `n${index}`]));
    const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replace(/[\r\n]/g, " ");
    return ["flowchart LR", ...report.diagnostics.flatMap(diagnostic => formatDiagnostic(diagnostic).split(/\r?\n/).map(line => `%% ${line}`)), ...nodes.map(node => `  ${ids.get(node.id)}["${escape(`${node.kind}: ${node.name}`)}"]`), ...edges.map(edge => `  ${ids.get(edge.from)} -->|${edge.kind}| ${ids.get(edge.to)}`), ""].join("\n");
  }
  const label = (id: string) => {
    const node = nodes.find(node => node.id === id)!;
    return node.kind === "module" ? `module ${JSON.stringify(node.name)}` : `${node.kind} ${node.name}`;
  };
  return [
    ...report.diagnostics.map(formatDiagnostic),
    `graph: ${report.ok ? report.focus === null ? "all designs" : `${report.direction} ${report.focus}, depth ${report.depth ?? "all"}` : "not available"}`,
    ...nodes.map(node => `  ${label(node.id)}${node.kind === "module" ? "" : ` (${node.module})`}`),
    ...edges.map(edge => `  ${label(edge.from)} --${edge.kind}--> ${label(edge.to)} (${edge.location.file}:${edge.location.line}:${edge.location.column})`), "",
  ].join("\n");
}
