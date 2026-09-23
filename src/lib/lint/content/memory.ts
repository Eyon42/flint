import { createDocument } from "../documents.js";
import type { ContentProvider, Target } from "../types.js";

export function createMemoryProvider(
  documents: Record<string, string>,
): ContentProvider {
  return {
    async read(target: Target) {
      const text = documents[target.path];
      if (text === undefined) {
        return null;
      }
      return createDocument(target.path, text);
    },
  };
}
