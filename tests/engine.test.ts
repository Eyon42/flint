import { describe, expect, it } from "vitest";
import { createMemoryProvider } from "../src/lib/lint/content/memory.js";
import { countSeverities, finalizeDiagnostics } from "../src/lib/lint/diagnostics.js";
import { runEngine } from "../src/lib/lint/engine.js";
import type { ResolvedRule } from "../src/lib/lint/rules/index.js";
import type { Rule } from "../src/lib/lint/types.js";
import { defined } from "./helpers.js";

function makeRule(id: string, onCheck: Rule["check"]): Rule {
  return {
    meta: { id, description: `test rule ${id}`, defaultSeverity: "warning" },
    check: onCheck,
  };
}

function resolved(rule: Rule, severity?: ResolvedRule["severity"]): ResolvedRule {
  return { rule, severity, options: {} };
}

const emitOne = makeRule("emit-one", (document) => [
  {
    ruleId: "emit-one",
    severity: "warning",
    message: "hit",
    path: document.path,
    range: { line: 1, column: 1 },
  },
]);

describe("runEngine", () => {
  it("collects diagnostics and counts linted and skipped files", async () => {
    const result = await runEngine({
      targets: [
        { path: "a.ts", source: "memory" },
        { path: "missing.ts", source: "memory" },
      ],
      provider: createMemoryProvider({ "a.ts": "content" }),
      rules: [resolved(emitOne)],
      cwd: ".",
      concurrency: 1,
    });

    expect(result.diagnostics).toHaveLength(1);
    expect(result.filesLinted).toBe(1);
    expect(result.filesSkipped).toBe(1);
    expect(result.toolDiagnostics).toEqual([]);
  });

  it("isolates a crashing rule and keeps running the others", async () => {
    const boom = makeRule("boom", () => {
      throw new Error("kaboom");
    });

    const result = await runEngine({
      targets: [{ path: "a.ts", source: "memory" }],
      provider: createMemoryProvider({ "a.ts": "content" }),
      rules: [resolved(boom), resolved(emitOne)],
      cwd: ".",
      concurrency: 1,
    });

    expect(result.diagnostics).toHaveLength(1);
    expect(result.toolDiagnostics).toHaveLength(1);
    expect(defined(result.toolDiagnostics[0]).message).toContain("kaboom");
    expect(defined(result.toolDiagnostics[0]).ruleId).toBe("boom");
  });

  it("applies a configured severity override", async () => {
    const result = await runEngine({
      targets: [{ path: "a.ts", source: "memory" }],
      provider: createMemoryProvider({ "a.ts": "content" }),
      rules: [resolved(emitOne, "error")],
      cwd: ".",
      concurrency: 1,
    });

    expect(defined(result.diagnostics[0]).severity).toBe("error");
    expect(countSeverities(result.diagnostics).errorCount).toBe(1);
  });

  it("aggregates rule notices with path and rule id", async () => {
    const noticeRule: Rule = {
      meta: {
        id: "notice-rule",
        description: "test rule notice-rule",
        defaultSeverity: "warning",
      },
      check: () => ({ diagnostics: [], notices: ["skipped: too big"] }),
    };

    const result = await runEngine({
      targets: [{ path: "a.ts", source: "memory" }],
      provider: createMemoryProvider({ "a.ts": "content" }),
      rules: [resolved(noticeRule)],
      cwd: ".",
      concurrency: 1,
    });

    expect(result.notices).toEqual([
      { path: "a.ts", ruleId: "notice-rule", message: "skipped: too big" },
    ]);
  });

  it("retains documents that produced a scored diagnostic", async () => {
    const scored = makeRule("scored", (document) => [
      {
        ruleId: "scored",
        severity: "warning",
        message: "hit",
        path: document.path,
        range: { line: 1, column: 1 },
        ...(document.text.startsWith("scored") ? { score: 0.5 } : {}),
      },
    ]);

    const result = await runEngine({
      targets: [
        { path: "a.ts", source: "memory" },
        { path: "b.ts", source: "memory" },
      ],
      provider: createMemoryProvider({
        "a.ts": "scored content",
        "b.ts": "plain content",
      }),
      rules: [resolved(scored)],
      cwd: ".",
      concurrency: 1,
    });

    expect([...result.scoredDocuments.keys()]).toEqual(["a.ts"]);
    expect(result.scoredDocuments.get("a.ts")?.text).toBe("scored content");
  });

  it("produces identical finalized output regardless of concurrency", async () => {
    const targets = Array.from({ length: 40 }, (_, index) => ({
      path: `file-${String(index).padStart(2, "0")}.ts`,
      source: "memory",
    }));
    const provider = createMemoryProvider(
      Object.fromEntries(targets.map((target) => [target.path, "content"])),
    );

    const options = { targets, provider, rules: [resolved(emitOne)], cwd: "." };
    const serial = await runEngine({ ...options, concurrency: 1 });
    const parallel = await runEngine({ ...options, concurrency: 8 });

    expect(finalizeDiagnostics(parallel.diagnostics)).toEqual(
      finalizeDiagnostics(serial.diagnostics),
    );
  });
});
