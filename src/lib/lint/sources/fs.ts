import { stat } from "node:fs/promises";
import path from "node:path";
import { glob } from "tinyglobby";
import type { Target } from "../types.js";

export const FS_SOURCE = "fs";

async function expandPattern(pattern: string, cwd: string): Promise<string[]> {
  const trimmed = pattern.replace(/\/+$/, "") || pattern;
  const absolute = path.resolve(cwd, pattern);

  try {
    const info = await stat(absolute);
    if (info.isDirectory()) {
      return glob([`${trimmed}/**/*`], { cwd, onlyFiles: true, dot: false });
    }
    if (info.isFile()) {
      return [path.relative(cwd, absolute)];
    }
  } catch {
    // not an existing path: treat as a glob pattern below
  }

  return glob([pattern], { cwd, onlyFiles: true, dot: false });
}

export async function fsTargets(
  patterns: readonly string[],
  cwd: string,
): Promise<Target[]> {
  const matches = await Promise.all(
    patterns.map((pattern) => expandPattern(pattern, cwd)),
  );

  const seen = new Set<string>();
  const targets: Target[] = [];
  for (const match of matches.flat()) {
    const normalized = match.split(path.sep).join("/");
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    targets.push({ path: normalized, source: FS_SOURCE });
  }
  return targets;
}
