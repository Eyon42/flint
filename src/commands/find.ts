import { UsageError } from "../lib/errors.js";
import type { LintConfig } from "../lib/lint/config.js";
import {
  findQuestion,
  FIND_QUESTION_ID,
} from "../lib/lint/rules/find.js";
import {
  jevRule,
  parseJevRuleOptions,
  type JevRuleOptions,
} from "../lib/lint/rules/jev.js";
import type { ResolvedRule } from "../lib/lint/rules/index.js";
import type { Severity } from "../lib/lint/types.js";
import {
  runCommand,
  type RunCommandDeps,
  type RunCommandOptions,
} from "./run.js";

export interface FindCommandOptions extends RunCommandOptions {
  severity?: Severity;
  min?: number;
  lineMin?: number;
}

export type FindCommandDeps = RunCommandDeps;

function resolveFindRules(
  config: LintConfig,
  query: string,
  options: FindCommandOptions,
): ResolvedRule[] {
  const configured = config.rules?.jev?.options;
  const base: JevRuleOptions =
    configured === undefined ? {} : parseJevRuleOptions(configured);

  const questionOptions: Parameters<typeof findQuestion>[0] = { query };
  if (options.severity !== undefined) {
    questionOptions.severity = options.severity;
  }
  if (options.min !== undefined) {
    questionOptions.min = options.min;
  }
  if (options.lineMin !== undefined) {
    questionOptions.lineMin = options.lineMin;
  }

  return [
    {
      rule: jevRule,
      options: {
        ...base,
        cache: false,
        questions: { [FIND_QUESTION_ID]: findQuestion(questionOptions) },
      } satisfies JevRuleOptions,
    },
  ];
}

export async function findCommand(
  query: string,
  patterns: string[],
  options: FindCommandOptions,
  deps: FindCommandDeps = {},
): Promise<number> {
  if (query.trim() === "") {
    throw new UsageError("find requires a non-empty query");
  }

  return runCommand({
    patterns,
    options,
    deps,
    rules: (config) => resolveFindRules(config, query, options),
    mode: "find",
  });
}
