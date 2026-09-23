import type { Target } from "../types.js";
import { fsTargets } from "./fs.js";
import { gitTargets, type GitClient, type GitMode } from "./git.js";
import { stdinTarget } from "./stdin.js";

export interface TargetOptions {
  cwd: string;
  patterns: readonly string[];
  git?: GitMode;
  stdin?: { text: string; filename?: string };
  gitClient: GitClient;
}

export async function resolveTargets(
  options: TargetOptions,
): Promise<Target[]> {
  if (options.stdin) {
    return [stdinTarget(options.stdin.filename)];
  }
  if (options.git) {
    return gitTargets(options.git, options.gitClient, options.cwd);
  }
  return fsTargets(options.patterns, options.cwd);
}
