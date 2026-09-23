import { open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import ignore from "ignore";
import type { Target } from "./types.js";

export const DEFAULT_EXCLUDES = [".git/", "node_modules/"];
const DEFAULT_EXCLUDE_SEGMENTS = new Set(["node_modules", ".git"]);
export const DEFAULT_MAX_FILE_SIZE = 1024 * 1024;
const BINARY_SNIFF_BYTES = 8192;

export interface SelectionOptions {
  cwd: string;
  ignores?: string[];
  match?: RegExp;
  maxFileSize?: number;
}

export interface SelectionResult {
  targets: Target[];
  considered: number;
  skipped: Record<string, number>;
}

export async function loadGitignore(cwd: string): Promise<string[]> {
  try {
    const content = await readFile(path.join(cwd, ".gitignore"), "utf8");
    return content.split(/\r?\n/).filter((line) => line.trim() !== "");
  } catch {
    return [];
  }
}

function toRelativePosix(cwd: string, filePath: string): string {
  const absolute = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(cwd, filePath);
  return path.relative(cwd, absolute).split(path.sep).join("/");
}

async function isBinary(filePath: string): Promise<boolean> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(BINARY_SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, BINARY_SNIFF_BYTES, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

export async function selectTargets(
  targets: readonly Target[],
  options: SelectionOptions,
): Promise<SelectionResult> {
  const matcher = ignore().add([
    ...DEFAULT_EXCLUDES,
    ...(await loadGitignore(options.cwd)),
    ...(options.ignores ?? []),
  ]);
  const maxFileSize = options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;

  const selected: Target[] = [];
  const skipped: Record<string, number> = {};
  const seen = new Set<string>();
  let considered = 0;

  const skip = (reason: string): void => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };

  for (const target of targets) {
    const relative = toRelativePosix(options.cwd, target.path);
    if (seen.has(relative)) {
      continue;
    }
    seen.add(relative);
    considered += 1;

    if (relative.startsWith("..")) {
      const segments = relative.split("/");
      if (segments.some((segment) => DEFAULT_EXCLUDE_SEGMENTS.has(segment))) {
        skip("ignored");
        continue;
      }
    } else if (matcher.ignores(relative)) {
      skip("ignored");
      continue;
    }
    if (options.match && !options.match.test(relative)) {
      skip("filtered");
      continue;
    }

    const absolute = path.resolve(options.cwd, relative);
    let info;
    try {
      info = await stat(absolute);
    } catch {
      skip("missing");
      continue;
    }
    if (!info.isFile()) {
      skip("notFile");
      continue;
    }
    if (info.size > maxFileSize) {
      skip("tooLarge");
      continue;
    }
    if (await isBinary(absolute)) {
      skip("binary");
      continue;
    }

    selected.push({ path: relative, source: target.source });
  }

  return { targets: selected, considered, skipped };
}
