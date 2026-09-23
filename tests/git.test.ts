import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UsageError } from "../src/lib/errors.js";
import {
  createGitClient,
  gitTargets,
  parseGitMode,
  type GitClient,
} from "../src/lib/lint/sources/git.js";
import { createTempDir, removeTempDir, writeFiles } from "./helpers.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

describe("parseGitMode", () => {
  it("parses supported modes", () => {
    expect(parseGitMode("staged")).toEqual({ kind: "staged" });
    expect(parseGitMode("working")).toEqual({ kind: "working" });
    expect(parseGitMode("diff:main...HEAD")).toEqual({
      kind: "diff",
      ref: "main...HEAD",
    });
  });

  it("rejects invalid modes", () => {
    expect(() => parseGitMode("diff:")).toThrow(UsageError);
    expect(() => parseGitMode("nope")).toThrow(UsageError);
  });
});

describe("gitTargets", () => {
  it("normalizes and dedupes paths", async () => {
    const client: GitClient = {
      changedFiles: async () => ["a.ts", "dir\\b.ts", "a.ts"],
    };

    const targets = await gitTargets({ kind: "staged" }, client, ".");

    expect(targets.map((entry) => entry.path)).toEqual(["a.ts", "dir/b.ts"]);
  });

  it("wraps client failures in UsageError", async () => {
    const client: GitClient = {
      changedFiles: async () => {
        throw new Error("fatal: not a git repository");
      },
    };

    await expect(gitTargets({ kind: "working" }, client, ".")).rejects.toThrow(
      /git diff failed/,
    );
  });
});

describe.runIf(await isGitAvailable())("git integration", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await createTempDir("flint-git-");
    await git(repo, "init", "-q");
    await git(repo, "config", "user.email", "test@example.com");
    await git(repo, "config", "user.name", "Test");
  });

  afterEach(async () => {
    await removeTempDir(repo);
  });

  it("reports staged, working, and diff targets", async () => {
    await writeFiles(repo, { "a.ts": "cow\n" });
    await git(repo, "add", "a.ts");
    await git(repo, "commit", "-qm", "init");

    await writeFiles(repo, { "a.ts": "cow\nmodified\n", "b.ts": "cow\n" });
    await git(repo, "add", "b.ts");

    const client = createGitClient();

    const staged = await gitTargets({ kind: "staged" }, client, repo);
    const working = await gitTargets({ kind: "working" }, client, repo);
    const diff = await gitTargets({ kind: "diff", ref: "HEAD" }, client, repo);

    expect(staged.map((entry) => entry.path)).toEqual(["b.ts"]);
    expect(working.map((entry) => entry.path)).toEqual(["a.ts"]);
    expect(diff.map((entry) => entry.path).toSorted()).toEqual([
      "a.ts",
      "b.ts",
    ]);
  });
});

async function isGitAvailable(): Promise<boolean> {
  try {
    await execFileAsync("git", ["--version"]);
    return true;
  } catch {
    return false;
  }
}
