import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { UsageError } from "../../errors.js";
import type { Target } from "../types.js";

const execFileAsync = promisify(execFile);

export const GIT_SOURCE = "git";

export type GitMode =
  | { kind: "staged" }
  | { kind: "working" }
  | { kind: "diff"; ref: string };

export interface GitClient {
  changedFiles(mode: GitMode, cwd: string): Promise<string[]>;
}

export function parseGitMode(value: string): GitMode {
  if (value === "staged") {
    return { kind: "staged" };
  }
  if (value === "working") {
    return { kind: "working" };
  }
  if (value.startsWith("diff:") && value.length > "diff:".length) {
    return { kind: "diff", ref: value.slice("diff:".length) };
  }
  throw new UsageError(
    `invalid git mode "${value}" (expected staged, working, or diff:<ref>)`,
  );
}

export function createGitClient(): GitClient {
  return {
    async changedFiles(mode, cwd) {
      const args = ["diff", "--name-only", "--diff-filter=ACMR"];
      if (mode.kind === "staged") {
        args.push("--cached");
      }
      if (mode.kind === "diff") {
        args.push(mode.ref);
      }

      const { stdout } = await execFileAsync("git", args, {
        cwd,
        maxBuffer: 64 * 1024 * 1024,
      });
      return stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    },
  };
}

export async function gitTargets(
  mode: GitMode,
  client: GitClient,
  cwd: string,
): Promise<Target[]> {
  let files: string[];
  try {
    files = await client.changedFiles(mode, cwd);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new UsageError(`git diff failed: ${message}`);
  }

  const seen = new Set<string>();
  const targets: Target[] = [];
  for (const file of files) {
    const normalized = file.split("\\").join("/");
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    targets.push({ path: normalized, source: GIT_SOURCE });
  }
  return targets;
}
