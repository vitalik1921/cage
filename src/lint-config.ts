export const CORE_LINT_CODES = ["W_HISTORY_REFERENCE", "W_OPEN_QUESTION_SETTLED", "W_NUMBERING", "W_MODULE_SIZE", "W_CONTRACT_SIZE", "W_RULE_REFERENCE_UNKNOWN", "W_TYPE_DUPLICATE"] as const;
export type CoreLintCode = typeof CORE_LINT_CODES[number];
export const LINT_CODES: ReadonlySet<string> = new Set([...CORE_LINT_CODES, "W_LINT_SUPPRESSION_UNUSED"]);

export interface LintConfig {
  severity: Record<string, "off" | "warn" | "error">;
  limits: { contractsPerModule: number; membersPerContract: number; rulesPerContract: number };
  historyPatterns: string[];
}

export const defaultLint: LintConfig = {
  severity: {},
  limits: { contractsPerModule: 5, membersPerContract: 7, rulesPerContract: 7 },
  historyPatterns: [],
};

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function validateLint(value: unknown): string[] {
  if (value === false) return [];
  if (!object(value)) return ['"lint" must be false or an object'];
  const errors: string[] = [];
  for (const key of Object.keys(value)) if (!Object.hasOwn(defaultLint, key)) errors.push(`unknown field "lint.${key}"`);
  if (value.severity !== undefined) {
    if (!object(value.severity)) errors.push('"lint.severity" must be an object');
    else for (const [code, level] of Object.entries(value.severity)) {
      if (!LINT_CODES.has(code)) errors.push(`unknown lint code "${code}"`);
      else if (level !== "off" && level !== "warn" && level !== "error") errors.push(`"lint.severity.${code}" must be "off", "warn" or "error"`);
    }
  }
  if (value.limits !== undefined) {
    if (!object(value.limits)) errors.push('"lint.limits" must be an object');
    else for (const [name, limit] of Object.entries(value.limits)) {
      if (!Object.hasOwn(defaultLint.limits, name)) errors.push(`unknown field "lint.limits.${name}"`);
      else if (!Number.isSafeInteger(limit) || (limit as number) < 0) errors.push(`"lint.limits.${name}" must be a non-negative safe integer`);
    }
  }
  if (value.historyPatterns !== undefined) {
    if (!Array.isArray(value.historyPatterns)) errors.push('"lint.historyPatterns" must be an array of regular expressions');
    else value.historyPatterns.forEach((pattern, index) => {
      if (typeof pattern !== "string" || !pattern.trim()) errors.push(`"lint.historyPatterns[${index}]" must be a non-empty regular expression`);
      else try { new RegExp(pattern, "iu"); } catch { errors.push(`invalid regular expression in "lint.historyPatterns[${index}]"`); }
    });
  }
  return errors;
}

export function resolveLint(given: false | Partial<LintConfig> | undefined): false | LintConfig {
  return given === false ? false : { ...defaultLint, ...given, severity: { ...given?.severity }, limits: { ...defaultLint.limits, ...given?.limits } };
}
