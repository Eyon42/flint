import { describe, expect, it } from "vitest";
import { ConfigError } from "../src/lib/errors.js";
import { builtinRules, resolveRules } from "../src/lib/lint/rules/index.js";

const JEV_OPTIONS = {
  questions: { urgent: { type: "noul", instructions: "Urgent?" } },
};

describe("resolveRules", () => {
  it("resolves the jev rule by default", () => {
    expect(resolveRules({}).map((entry) => entry.rule.meta.id)).toEqual([
      "jev",
    ]);
  });

  it("honors enabled: false and passes options through", () => {
    expect(
      resolveRules({ rules: { jev: { enabled: false } } }),
    ).toEqual([]);

    const [resolved] = resolveRules({
      rules: { jev: { options: JEV_OPTIONS, severity: "error" } },
    });
    expect(resolved?.severity).toBe("error");
    expect(resolved?.options).toEqual(JEV_OPTIONS);
  });

  it("validates rule options at resolve time", () => {
    expect(() =>
      resolveRules({ rules: { jev: { options: { questions: {} } } } }),
    ).toThrowError(ConfigError);
    expect(() =>
      resolveRules({ rules: { jev: { options: {} }, unknown: {} } }),
    ).toThrowError(/unknown rule "unknown"/);
  });

  it("keeps the builtin registry stable", () => {
    expect(builtinRules.map((rule) => rule.meta.id)).toEqual(["jev"]);
  });
});
