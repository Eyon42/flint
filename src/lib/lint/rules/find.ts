import type { Severity } from "../types.js";
import type { JevRuleQuestion } from "./jev.js";

export const FIND_QUESTION_ID = "find";
export const DEFAULT_FIND_MIN = 0.8;
export const DEFAULT_FIND_LINE_MIN = 0.3;

export interface FindQuestionOptions {
  query: string;
  severity?: Severity;
  min?: number;
  lineMin?: number;
}

/**
 * Builds the one-off noul question used by `flint find`: the query is phrased
 * as a statement about the code and localized through the usual funnel.
 */
export function findQuestion(options: FindQuestionOptions): JevRuleQuestion {
  const query = options.query.trim();
  return {
    type: "noul",
    instructions: `The code contains at least one match for the following query: ${query}`,
    criteria: {
      true: `At least one line or block in the code matches the query: ${query}`,
      false: `No line or block in the code matches the query: ${query}`,
    },
    report: {
      message: query,
      min: options.min ?? DEFAULT_FIND_MIN,
      severity: options.severity ?? "info",
    },
    locate: { lineMin: options.lineMin ?? DEFAULT_FIND_LINE_MIN },
  };
}
