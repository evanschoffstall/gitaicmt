/** Small formatting helpers for composing prompt rule lists without duplicating string decoration. */

/** Prefixes every rule with the prompt-local bullet or indentation marker. */
export function prefixRules(rules: string[], prefix: string): string[] {
  return rules.map((rule) => `${prefix}${rule}`);
}
