import type { LintConfig } from "../config.js";
import { ConfigError } from "../../errors.js";
import type { Rule, Severity } from "../types.js";
import { jevRule } from "./jev.js";

export const builtinRules: readonly Rule[] = [jevRule];

export interface ResolvedRule {
  rule: Rule;
  severity?: Severity;
  options: unknown;
}

export function resolveRules(config: LintConfig): ResolvedRule[] {
  const settings = config.rules ?? {};
  const known = new Set(builtinRules.map((rule) => rule.meta.id));

  for (const id of Object.keys(settings)) {
    if (!known.has(id)) {
      throw new ConfigError(`unknown rule "${id}" in config`);
    }
  }

  return builtinRules
    .filter((rule) => settings[rule.meta.id]?.enabled !== false)
    .map((rule) => {
      const setting = settings[rule.meta.id];
      const options = setting?.options ?? {};
      rule.validateOptions?.(options);
      return {
        rule,
        severity: setting?.severity,
        options,
      };
    });
}
