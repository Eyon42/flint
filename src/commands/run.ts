import { getJevStats } from "../lib/ai/jev.js";
import { UsageError } from "../lib/errors.js";
import { loadConfig, type LintConfig } from "../lib/lint/config.js";
import { createDiskProvider } from "../lib/lint/content/disk.js";
import { createMemoryProvider } from "../lib/lint/content/memory.js";
import {
  countSeverities,
  finalizeDiagnostics,
} from "../lib/lint/diagnostics.js";
import { runEngine } from "../lib/lint/engine.js";
import {
  resolveFormatter,
  type FormatterName,
} from "../lib/lint/formatters/index.js";
import { reportResult } from "../lib/lint/reporter.js";
import type { ResolvedRule } from "../lib/lint/rules/index.js";
import {
  selectTargets,
  type SelectionResult,
} from "../lib/lint/selection.js";
import { resolveTargets } from "../lib/lint/sources/index.js";
import {
  createGitClient,
  type GitClient,
  type GitMode,
} from "../lib/lint/sources/git.js";
import {
  DEFAULT_STDIN_FILENAME,
  readStdinText,
  stdinTarget,
} from "../lib/lint/sources/stdin.js";
import type {
  ContentProvider,
  Notice,
  RunResult,
  RunSummary,
  Target,
} from "../lib/lint/types.js";

export interface RunCommandOptions {
  git?: GitMode;
  stdin?: boolean;
  stdinFilename?: string;
  config?: string;
  format?: FormatterName;
  match?: RegExp;
  maxWarnings?: number;
  color?: boolean;
}

export interface RunCommandDeps {
  cwd?: string;
  write?: (text: string) => void;
  isTty?: boolean;
  gitClient?: GitClient;
  readStdin?: () => Promise<string>;
}

export interface RunCommandInput {
  patterns: string[];
  options: RunCommandOptions;
  deps: RunCommandDeps;
  /** Builds the resolved rules once the config file has been loaded. */
  rules: (config: LintConfig) => ResolvedRule[];
  /** Summary wording used by the pretty formatter. */
  mode?: RunResult["mode"];
}

export async function runCommand(input: RunCommandInput): Promise<number> {
  const { patterns, options, deps } = input;

  if (options.stdinFilename !== undefined && !options.stdin) {
    throw new UsageError("--stdin-filename requires --stdin");
  }

  const cwd = deps.cwd ?? process.cwd();
  const write =
    deps.write ??
    ((text: string) => {
      process.stdout.write(text);
    });
  const isTty = deps.isTty ?? Boolean(process.stdout.isTTY);
  const gitClient = deps.gitClient ?? createGitClient();
  const readStdin = deps.readStdin ?? readStdinText;

  const { config } = await loadConfig({ cwd, configPath: options.config });
  const formatter = resolveFormatter(options.format ?? config.format ?? "pretty");
  const rules = input.rules(config);

  let targets: Target[];
  let provider: ContentProvider;
  let selection: SelectionResult | undefined;

  if (options.stdin) {
    const text = await readStdin();
    const filename = options.stdinFilename ?? DEFAULT_STDIN_FILENAME;
    targets = [stdinTarget(filename)];
    provider = createMemoryProvider({ [filename]: text });
  } else {
    const configuredPatterns = config.include ?? [];
    const effectivePatterns =
      patterns.length > 0
        ? patterns
        : configuredPatterns.length > 0
          ? configuredPatterns
          : ["."];

    targets = await resolveTargets({
      cwd,
      patterns: effectivePatterns,
      git: options.git,
      gitClient,
    });
    provider = createDiskProvider(cwd);
    selection = await selectTargets(targets, {
      cwd,
      ignores: config.exclude,
      match:
        options.match ??
        (config.match !== undefined ? new RegExp(config.match) : undefined),
    });
    targets = selection.targets;
  }

  const aiBefore = getJevStats();
  const engineResult = await runEngine({
    targets,
    provider,
    rules,
    cwd,
    concurrency: config.concurrency,
  });
  const aiAfter = getJevStats();

  const diagnostics = finalizeDiagnostics(engineResult.diagnostics);
  const counts = countSeverities(diagnostics);
  const selectionSkipped = Object.values(selection?.skipped ?? {}).reduce(
    (total, count) => total + count,
    0,
  );

  const summary: RunSummary = {
    filesConsidered: selection?.considered ?? targets.length,
    filesLinted: engineResult.filesLinted,
    filesSkipped: selectionSkipped + engineResult.filesSkipped,
    ...counts,
    durationMs: engineResult.durationMs,
  };
  const ai = {
    requests: aiAfter.requests - aiBefore.requests,
    inputTokens: aiAfter.inputTokens - aiBefore.inputTokens,
    outputTokens: aiAfter.outputTokens - aiBefore.outputTokens,
    cost: Number((aiAfter.cost - aiBefore.cost).toFixed(6)),
  };
  if (ai.requests > 0) {
    summary.ai = ai;
  }

  const notices: Notice[] = [...engineResult.notices];
  if (
    selection !== undefined &&
    options.git === undefined &&
    patterns.length > 0 &&
    selection.considered === 0
  ) {
    notices.unshift({
      message: `no files matched the given patterns: ${patterns
        .map((pattern) => `"${pattern}"`)
        .join(", ")}. Run \`flint --help\` for the available commands.`,
    });
  }

  const result: RunResult = {
    diagnostics,
    toolDiagnostics: engineResult.toolDiagnostics,
    notices,
    summary,
  };
  if (input.mode !== undefined) {
    result.mode = input.mode;
  }

  return reportResult(result, {
    formatter,
    color: (options.color ?? true) && isTty,
    write,
    maxWarnings: options.maxWarnings ?? config.maxWarnings,
    documents: engineResult.scoredDocuments,
  });
}
