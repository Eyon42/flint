import { readFile } from "node:fs/promises";
import path from "node:path";
import { createDocument } from "../documents.js";
import type { ContentProvider, Target } from "../types.js";

export function createDiskProvider(cwd: string): ContentProvider {
  return {
    async read(target: Target) {
      let text: string;
      try {
        text = await readFile(path.resolve(cwd, target.path), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return null;
        }
        throw error;
      }
      return createDocument(target.path, text);
    },
  };
}
