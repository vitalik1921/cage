import type { Edge } from "./design-model.ts";

/**
 * Cycles between design modules, each as its edges in order. A group of
 * mutually dependent modules is reported once, by a shortest cycle through
 * its first module. Dependencies inside one module are not cycles.
 */
export function findModuleCycles(edges: readonly Edge[]): Edge[][] {
  const dependencies = new Map<string, Map<string, Edge>>();
  for (const edge of edges) {
    if (edge.fromModule === edge.toModule) continue;
    const targets = dependencies.get(edge.fromModule) ?? new Map<string, Edge>();
    dependencies.set(edge.fromModule, targets);
    if (!targets.has(edge.toModule)) targets.set(edge.toModule, edge);
  }
  const targetsOf = (module: string) => [...(dependencies.get(module)?.keys() ?? [])].sort();

  /** Breadth first from `start`: the edge by which each reachable module, `start` included, is first reached. */
  const reach = (start: string): Map<string, Edge> => {
    const reachedBy = new Map<string, Edge>();
    const queue = [start];
    for (let next = 0; next < queue.length; next++) {
      for (const target of targetsOf(queue[next])) {
        if (reachedBy.has(target)) continue;
        reachedBy.set(target, dependencies.get(queue[next])!.get(target)!);
        if (target !== start) queue.push(target);
      }
    }
    return reachedBy;
  };

  const cycles: Edge[][] = [];
  const grouped = new Set<string>();
  for (const start of [...dependencies.keys()].sort()) {
    if (grouped.has(start)) continue;
    const reachedBy = reach(start);
    const closing = reachedBy.get(start);
    if (!closing) continue;
    // Everything that reaches back to `start` is in its group and needs no report of its own.
    for (const module of reachedBy.keys()) if (reach(module).has(start)) grouped.add(module);

    const cycle = [closing];
    while (cycle[0].fromModule !== start) cycle.unshift(reachedBy.get(cycle[0].fromModule)!);
    cycles.push(cycle);
  }
  return cycles;
}
