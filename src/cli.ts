import { Command, InvalidArgumentError } from "commander";
import {
  cacheClearCommand,
  type CacheCommandDeps,
} from "./commands/cache.js";
import {
  findCommand,
  type FindCommandDeps,
  type FindCommandOptions,
} from "./commands/find.js";
import {
  lintCommand,
  type LintCommandDeps,
  type LintCommandOptions,
} from "./commands/lint.js";
import { parseGitMode, type GitMode } from "./lib/lint/sources/git.js";
import type { FormatterName } from "./lib/lint/formatters/index.js";
import type { Severity } from "./lib/lint/types.js";

export const VERSION = "0.1.0";

export interface CliState {
  exitCode: number;
}

export interface CliDeps {
  lint?: LintCommandDeps;
  find?: FindCommandDeps;
  cache?: CacheCommandDeps;
}

function parseGit(value: string): GitMode {
  try {
    return parseGitMode(value);
  } catch (error) {
    throw new InvalidArgumentError(
      error instanceof Error ? error.message : String(error),
    );
  }
}

function parseFormat(value: string): FormatterName {
  if (value !== "pretty" && value !== "json") {
    throw new InvalidArgumentError("format must be pretty or json");
  }
  return value;
}

function parseMatch(value: string): RegExp {
  try {
    return new RegExp(value);
  } catch {
    throw new InvalidArgumentError("match must be a valid regular expression");
  }
}

function parseMaxWarnings(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new InvalidArgumentError(
      "max-warnings must be a non-negative integer",
    );
  }
  return parsed;
}

function parseSeverity(value: string): Severity {
  if (value !== "error" && value !== "warning" && value !== "info") {
    throw new InvalidArgumentError("severity must be error, warning, or info");
  }
  return value;
}

function parseProbability(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new InvalidArgumentError(
      "probability must be a number between 0 and 1",
    );
  }
  return parsed;
}

export function createProgram(
  state: CliState = { exitCode: 0 },
  deps: CliDeps = {},
): Command {
  const program = new Command();

  program
    .name("flint")
    .description("Pluggable linter with an engine built for AI-assisted analysis")
    .version(VERSION)
    .showHelpAfterError("(run `flint --help` for usage)")
    .exitOverride();

  program
    .command("lint", { isDefault: true })
    .description("lint files (default command)")
    .argument("[patterns...]", "files, directories, or glob patterns (default: .)")
    .option(
      "--git <mode>",
      "lint files changed in git: staged, working, or diff:<ref>",
      parseGit,
    )
    .option("--stdin", "lint content read from stdin")
    .option("--stdin-filename <path>", "path to report for --stdin input")
    .option("-c, --config <path>", "path to a flint config file")
    .option("--format <format>", "output format: pretty or json", parseFormat)
    .option("--match <regex>", "only lint files whose path matches this regex", parseMatch)
    .option(
      "--max-warnings <n>",
      "exit with code 1 when warnings exceed n",
      parseMaxWarnings,
    )
    .option("--no-color", "disable colored output")
    .action(
      async (patterns: string[], options: LintCommandOptions) => {
        state.exitCode = await lintCommand(patterns, options, deps.lint);
      },
    );

  program
    .command("find")
    .description("run a one-off AI query over files")
    .argument("<query>", "what to find, in natural language")
    .argument("[patterns...]", "files, directories, or glob patterns (default: .)")
    .option(
      "--git <mode>",
      "find files changed in git: staged, working, or diff:<ref>",
      parseGit,
    )
    .option("--stdin", "find in content read from stdin")
    .option("--stdin-filename <path>", "path to report for --stdin input")
    .option("-c, --config <path>", "path to a flint config file")
    .option("--format <format>", "output format: pretty or json", parseFormat)
    .option("--match <regex>", "only find files whose path matches this regex", parseMatch)
    .option(
      "--severity <severity>",
      "severity of matches: error, warning, or info (default: info)",
      parseSeverity,
    )
    .option(
      "--min <probability>",
      "minimum file probability to report a match (default: 0.8)",
      parseProbability,
    )
    .option(
      "--line-min <probability>",
      "minimum line probability to report a match (default: 0.3)",
      parseProbability,
    )
    .option(
      "--max-warnings <n>",
      "exit with code 1 when warnings exceed n",
      parseMaxWarnings,
    )
    .option("--no-color", "disable colored output")
    .action(
      async (
        query: string,
        patterns: string[],
        options: FindCommandOptions,
      ) => {
        state.exitCode = await findCommand(query, patterns, options, deps.find);
      },
    );

  program
    .command("cache")
    .description("manage the cache")
    .command("clear")
    .description("remove the cache directory")
    .action(async () => {
      state.exitCode = await cacheClearCommand(deps.cache);
    });

  program.addHelpText(
    "after",
    [
      "",
      "Examples:",
      "  $ flint src tests                        lint files (lint is the default command)",
      '  $ flint find "all uses of Promise.all"   run a one-off query',
      "  $ flint --git staged                     lint files staged in git",
      "  $ flint cache clear                      remove .flint-cache",
    ].join("\n"),
  );

  return program;
}
