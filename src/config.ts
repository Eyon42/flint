export { defineConfig } from "./lib/lint/config.js";
export type { LintConfig, RuleSetting } from "./lib/lint/config.js";
export {
  presets,
  qualityQuestions,
  securityQuestions,
} from "./lib/lint/rules/presets/index.js";
export type { JevPresetName } from "./lib/lint/rules/presets/index.js";
export type {
  AiSummary,
  Diagnostic,
  DiagnosticRange,
  Document,
  Notice,
  RuleCheckResult,
  RunResult,
  RunSummary,
  Severity,
} from "./lib/lint/types.js";
