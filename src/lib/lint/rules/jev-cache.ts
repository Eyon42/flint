import { createHash } from "node:crypto";
import type { Document } from "../types.js";
import type { JevRuleQuestion } from "./jev.js";

/** Bump when funnel prompts, criteria rendering, or key composition change. */
export const CACHE_VERSION = 3;

export function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function hashRuleset(
  model: string,
  questions: Record<string, JevRuleQuestion>,
): string {
  return hashJson({ version: CACHE_VERSION, model, questions });
}

export function hashDocument(document: Document): string {
  return hashJson({
    path: document.path,
    language: document.language,
    text: document.text,
  });
}

export interface JevRequestKeyInput {
  rulesetHash: string;
  stage: "classify" | "refine";
  variant: "localized" | "plain";
  /** Exact state sent to the API, including part or chunk line offsets. */
  state: unknown;
  /** Exact questions sent to the API, including rendered criteria. */
  questions: unknown;
}

/**
 * Keys the cache on the serialized request, so any change to the state,
 * criteria, chunking, or ruleset invalidates the entry. Refinement entries are
 * reused while the chunk's numbered state and line criteria stay identical.
 */
export function jevRequestKey(input: JevRequestKeyInput): string {
  return hashJson({ version: CACHE_VERSION, ...input });
}
