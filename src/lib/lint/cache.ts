import path from "node:path";

export const FLINT_CACHE_DIR = ".flint-cache";

export function cacheDir(cwd: string): string {
  return path.join(cwd, FLINT_CACHE_DIR);
}

export function jevCacheDir(cwd: string): string {
  return path.join(cacheDir(cwd), "jev");
}
