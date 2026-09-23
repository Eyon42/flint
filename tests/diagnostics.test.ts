import { describe, expect, it } from "vitest";
import {
  countSeverities,
  finalizeDiagnostics,
} from "../src/lib/lint/diagnostics.js";
import type { Diagnostic } from "../src/lib/lint/types.js";

function diagnostic(overrides: Partial<Diagnostic>): Diagnostic {
  return {
    ruleId: "rule",
    severity: "warning",
    message: "message",
    path: "a.ts",
    range: { line: 1, column: 1 },
    ...overrides,
  };
}

describe("finalizeDiagnostics", () => {
  it("sorts by path, position, then rule", () => {
    const sorted = finalizeDiagnostics([
      diagnostic({ path: "b.ts" }),
      diagnostic({ path: "a.ts", range: { line: 2, column: 1 } }),
      diagnostic({ ruleId: "z", path: "a.ts", range: { line: 1, column: 5 } }),
      diagnostic({ ruleId: "a", path: "a.ts", range: { line: 1, column: 5 } }),
    ]);

    expect(
      sorted.map(
        (entry) => `${entry.path}:${entry.range.line}:${entry.range.column}:${entry.ruleId}`,
      ),
    ).toEqual(["a.ts:1:5:a", "a.ts:1:5:z", "a.ts:2:1:rule", "b.ts:1:1:rule"]);
  });

  it("removes exact duplicates", () => {
    const duplicates = [diagnostic({}), diagnostic({}), diagnostic({ message: "other" })];
    expect(finalizeDiagnostics(duplicates)).toHaveLength(2);
  });
});

describe("countSeverities", () => {
  it("counts each severity", () => {
    const counts = countSeverities([
      diagnostic({ severity: "error" }),
      diagnostic({ severity: "warning" }),
      diagnostic({ severity: "info" }),
      diagnostic({ severity: "info" }),
    ]);

    expect(counts).toEqual({ errorCount: 1, warningCount: 1, infoCount: 2 });
  });
});
