import type { Contract, DesignIndex } from "./design-model.ts";
import type { DesignModule } from "./design-phase.ts";
import type { Diagnostic } from "./diagnostic.ts";

/** Bind after TypeScript resolves members, before the existing invariant inheritance pass. */
export function bindGherkinRules(modules: readonly DesignModule[], index: DesignIndex, hasMember: (contract: Contract, member: string) => boolean): { diagnostics: Diagnostic[]; carriers: Set<string> } {
  const diagnostics: Diagnostic[] = [];
  const carriers = new Set<string>();
  for (const module of modules) for (const document of module.documents) {
    for (const rule of document.gherkin?.rules ?? []) {
      if (rule.assumption) {
        (index.assumptions ??= []).push({ module: module.moduleId, rule });
        continue;
      }
      const carrier = rule.carrier;
      if (!carrier) continue; // Reported during parsing.
      const contract = index.contracts.find(candidate => candidate.module === module.moduleId && candidate.name === carrier.contract);
      if (contract) carriers.add(contract.name);
      if (!contract || carrier.member !== null && !hasMember(contract, carrier.member)) {
        diagnostics.push({ code: "E_RULE_UNBOUND", severity: "error", message: `${carrier.contract}${carrier.member === null ? "" : "." + carrier.member}: no such contract, family or member in ${module.moduleId}`, ...carrier.location });
        continue;
      }
      const first = index.invariants.find(candidate => candidate.contract === contract.name && candidate.id === rule.id);
      if (first) {
        diagnostics.push({ code: "E_INVARIANT_DUPLICATE", severity: "error", message: `${contract.name}.${rule.id} declared twice`, contract: contract.name, invariant: rule.id, ...rule.location, related: [{ message: "the other invariant", ...first.location }] });
        continue;
      }
      index.invariants.push({ contract: contract.name, id: rule.id, text: rule.text, member: carrier.member, location: rule.location, gherkin: rule });
    }
  }
  for (const locked of index.locked) {
    if (locked.kind !== "contract" || !carriers.has(locked.name)) continue;
    locked.invariants = Object.fromEntries(index.invariants.filter(rule => rule.contract === locked.name).map(rule => [rule.id, rule.text.replace(/\s+/g, " ")]));
  }
  return { diagnostics, carriers };
}
