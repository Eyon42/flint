import { describe, expect, it } from "vitest";
import { createDocument } from "../src/lib/lint/documents.js";
import {
  batchQuestionGroups,
  fitsBudget,
  partitionParts,
  requestBudgetChars,
  type QuestionGroup,
} from "../src/lib/lint/rules/jev-budget.js";

describe("requestBudgetChars", () => {
  it("keeps a 20% margin below the context window", () => {
    expect(
      requestBudgetChars({ contextTokens: 32_768, reservedOutputTokens: 2_048 }),
    ).toBe(73_728);
    expect(
      requestBudgetChars({ contextTokens: 100, reservedOutputTokens: 100 }),
    ).toBe(0);
  });
});

describe("fitsBudget", () => {
  it("rejects payloads above the derived budget", () => {
    const budget = { contextTokens: 32_768, reservedOutputTokens: 2_048 };
    expect(fitsBudget(73_728, budget)).toBe(true);
    expect(fitsBudget(73_729, budget)).toBe(false);
  });
});

function documentOf(lines: number, width: number) {
  const text = `${Array.from({ length: lines }, () => "x".repeat(width)).join(
    "\n",
  )}\n`;
  return createDocument("src/a.ts", text);
}

describe("partitionParts", () => {
  it("splits at line boundaries under the character budget", () => {
    const document = documentOf(10, 20);
    const { parts, oversized } = partitionParts(document, 100);
    expect(oversized).toBe(false);
    expect(parts).toEqual([
      { index: 1, startLine: 1, endLine: 4 },
      { index: 2, startLine: 5, endLine: 8 },
      { index: 3, startLine: 9, endLine: 10 },
    ]);
  });

  it("prefers structural boundaries", () => {
    const text = `${[
      "a".repeat(20),
      "a".repeat(20),
      "",
      "b".repeat(20),
      "b".repeat(20),
    ].join("\n")}\n`;
    const document = createDocument("src/a.ts", text);
    const { parts } = partitionParts(document, 60);
    expect(parts).toEqual([
      { index: 1, startLine: 1, endLine: 3 },
      { index: 2, startLine: 4, endLine: 5 },
    ]);
  });

  it("flags a single line that cannot fit", () => {
    const large = createDocument("src/a.ts", `${"y".repeat(500)}\n`);
    expect(partitionParts(large, 100).oversized).toBe(true);
  });
});

describe("batchQuestionGroups", () => {
  const groups: Array<QuestionGroup<number>> = [
    { id: "a", questions: { a: 1 } },
    { id: "b", questions: { b: 2 } },
    { id: "c", questions: { c: 3 } },
  ];

  it("packs groups while the payload fits", () => {
    expect(
      batchQuestionGroups(groups, (questions) => Object.keys(questions).length <= 2),
    ).toEqual([{ a: 1, b: 2 }, { c: 3 }]);
  });

  it("returns undefined when one group cannot fit alone", () => {
    expect(batchQuestionGroups(groups, () => false)).toBeUndefined();
  });
});
