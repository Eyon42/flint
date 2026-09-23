import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Loads `.env` from the working directory when present. Variables already set
 * in the environment win, and a missing or malformed file never fails a run.
 */
export function loadDotEnv(cwd: string): void {
  const filePath = path.join(cwd, ".env");
  if (!existsSync(filePath)) {
    return;
  }
  try {
    process.loadEnvFile(filePath);
  } catch {
    // A malformed .env must not crash the CLI; the shell environment still works.
  }
}
