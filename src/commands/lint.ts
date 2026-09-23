import { resolveRules } from "../lib/lint/rules/index.js";
import {
  runCommand,
  type RunCommandDeps,
  type RunCommandOptions,
} from "./run.js";

export type LintCommandOptions = RunCommandOptions;
export type LintCommandDeps = RunCommandDeps;

export async function lintCommand(
  patterns: string[],
  options: LintCommandOptions,
  deps: LintCommandDeps = {},
): Promise<number> {
  return runCommand({
    patterns,
    options,
    deps,
    rules: resolveRules,
    mode: "lint",
  });
}
