import { UsageError } from "../../errors.js";
import type { Target } from "../types.js";

export const STDIN_SOURCE = "stdin";
export const DEFAULT_STDIN_FILENAME = "<stdin>";

export function stdinTarget(filename: string = DEFAULT_STDIN_FILENAME): Target {
  return { path: filename, source: STDIN_SOURCE };
}

export async function readStdinText(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new UsageError("--stdin requires piped input");
  }

  let input = "";
  for await (const chunk of process.stdin) {
    input += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  }
  return input;
}
