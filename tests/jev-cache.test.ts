import { describe, expect, it } from "vitest";
import type { JevRuleQuestion } from "../src/lib/lint/rules/jev.js";
import {
  hashDocument,
  hashRuleset,
  jevRequestKey,
} from "../src/lib/lint/rules/jev-cache.js";
import type { Document } from "../src/lib/lint/types.js";

function makeDocument(overrides: Partial<Document> = {}): Document {
  return {
    path: "src/a.ts",
    language: "ts",
    text: "const a = 1;\n",
    lineStarts: [0],
    ...overrides,
  };
}

const BASE_QUESTION: JevRuleQuestion = {
  type: "noul",
  instructions: "The code mentions cows",
  report: { min: 0.8 },
  locate: { lineMin: 0.3 },
};

function makeRuleset(
  question: JevRuleQuestion = BASE_QUESTION,
): Record<string, JevRuleQuestion> {
  return { "no-cow": question };
}

describe("hashRuleset", () => {
  it("is deterministic", () => {
    expect(hashRuleset("m", makeRuleset())).toBe(
      hashRuleset("m", makeRuleset()),
    );
  });

  it("changes when the model changes", () => {
    expect(hashRuleset("m", makeRuleset())).not.toBe(
      hashRuleset("other", makeRuleset()),
    );
  });

  it("changes when instructions change", () => {
    const changed = { ...BASE_QUESTION, instructions: "The code mentions sheep" };
    expect(hashRuleset("m", makeRuleset())).not.toBe(
      hashRuleset("m", makeRuleset(changed)),
    );
  });

  it("changes when locate options change", () => {
    const changed = {
      ...BASE_QUESTION,
      locate: { lineMin: 0.3, chunkLines: 40 },
    };
    expect(hashRuleset("m", makeRuleset())).not.toBe(
      hashRuleset("m", makeRuleset(changed)),
    );
  });

  it("changes when report options change", () => {
    const changed = { ...BASE_QUESTION, report: { min: 0.9 } };
    expect(hashRuleset("m", makeRuleset())).not.toBe(
      hashRuleset("m", makeRuleset(changed)),
    );
  });
});

describe("hashDocument", () => {
  it("is deterministic", () => {
    expect(hashDocument(makeDocument())).toBe(hashDocument(makeDocument()));
  });

  it("changes when text, path, or language change", () => {
    const base = hashDocument(makeDocument());
    expect(hashDocument(makeDocument({ text: "const b = 2;\n" }))).not.toBe(base);
    expect(hashDocument(makeDocument({ path: "src/b.ts" }))).not.toBe(base);
    expect(hashDocument(makeDocument({ language: "tsx" }))).not.toBe(base);
  });

  it("ignores derived line starts", () => {
    expect(hashDocument(makeDocument({ lineStarts: [0, 14] }))).toBe(
      hashDocument(makeDocument()),
    );
  });
});

describe("jevRequestKey", () => {
  const base = {
    rulesetHash: "rules",
    stage: "classify" as const,
    variant: "localized" as const,
    state: { path: "src/a.ts", text: "const a = 1;\n" },
    questions: { a: { type: "noul", instructions: "A?" } },
  };

  it("is deterministic", () => {
    expect(jevRequestKey(base)).toBe(jevRequestKey(base));
  });

  it("changes with stage, ruleset, variant, state, and questions", () => {
    expect(jevRequestKey({ ...base, stage: "refine" })).not.toBe(
      jevRequestKey(base),
    );
    expect(jevRequestKey({ ...base, rulesetHash: "other" })).not.toBe(
      jevRequestKey(base),
    );
    expect(jevRequestKey({ ...base, variant: "plain" })).not.toBe(
      jevRequestKey(base),
    );
    expect(
      jevRequestKey({ ...base, state: { path: "src/a.ts", text: "next();\n" } }),
    ).not.toBe(jevRequestKey(base));
    expect(
      jevRequestKey({
        ...base,
        questions: { a: { type: "noul", instructions: "B?" } },
      }),
    ).not.toBe(jevRequestKey(base));
  });

  it("reuses refinement keys while the chunk state is unchanged", () => {
    const refine = {
      ...base,
      stage: "refine" as const,
      state: { path: "src/a.ts", startLine: 4, endLine: 6, text: "4 | x" },
    };
    expect(
      jevRequestKey({
        ...refine,
        state: { path: "src/a.ts", startLine: 4, endLine: 6, text: "4 | x" },
      }),
    ).toBe(jevRequestKey(refine));
  });
});
