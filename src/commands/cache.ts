import { rm, stat } from "node:fs/promises";
import { cacheDir, FLINT_CACHE_DIR } from "../lib/lint/cache.js";

export interface CacheCommandDeps {
  cwd?: string;
  write?: (text: string) => void;
}

export async function cacheClearCommand(
  deps: CacheCommandDeps = {},
): Promise<number> {
  const cwd = deps.cwd ?? process.cwd();
  const write =
    deps.write ??
    ((text: string) => {
      process.stdout.write(text);
    });
  const root = cacheDir(cwd);

  let exists: boolean;
  try {
    await stat(root);
    exists = true;
  } catch {
    exists = false;
  }

  if (!exists) {
    write("No cache to clear.\n");
    return 0;
  }

  await rm(root, { recursive: true, force: true });
  write(`Cleared ${FLINT_CACHE_DIR}.\n`);
  return 0;
}
