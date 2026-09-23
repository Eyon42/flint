import { styleText } from "node:util";
import { describe, expect, it } from "vitest";
import { createDocument } from "../src/lib/lint/documents.js";
import { jsonFormatter } from "../src/lib/lint/formatters/json.js";
import { prettyFormatter } from "../src/lib/lint/formatters/pretty.js";
import { reportResult } from "../src/lib/lint/reporter.js";
import type {
  Diagnostic,
  Document,
  RunResult,
} from "../src/lib/lint/types.js";

interface ResultOverrides {
  diagnostics?: RunResult["diagnostics"];
  toolDiagnostics?: RunResult["toolDiagnostics"];
  notices?: RunResult["notices"];
  summary?: Partial<RunResult["summary"]>;
  mode?: RunResult["mode"];
}

function result(overrides: ResultOverrides = {}): RunResult {
  const summary = {
    filesConsidered: 1,
    filesLinted: 1,
    filesSkipped: 0,
    errorCount: 0,
    warningCount: 1,
    infoCount: 0,
    durationMs: 1,
    ...overrides.summary,
  };

  return {
    diagnostics:
      overrides.diagnostics ?? [
        {
          ruleId: "static-rule",
          severity: "warning",
          message: "found something",
          path: "src/a.ts",
          range: { line: 2, column: 3, endLine: 2, endColumn: 6 },
        },
      ],
    toolDiagnostics: overrides.toolDiagnostics ?? [],
    notices: overrides.notices ?? [],
    summary,
    mode: overrides.mode,
  };
}

function documentOf(lines: number, filePath = "src/a.ts"): Document {
  const text = `${Array.from(
    { length: lines },
    (_, index) => `line ${index + 1}`,
  ).join("\n")}\n`;
  return createDocument(filePath, text);
}

function aiFinding(overrides: Partial<Diagnostic> = {}): Diagnostic {
  return {
    ruleId: "no-sensitive-logging",
    severity: "error",
    message: 'Jev "no-sensitive-logging": line 3 (p=0.91)',
    path: "src/a.ts",
    range: { line: 3, column: 1, endLine: 3, endColumn: 7 },
    score: 0.79,
    ...overrides,
  };
}

function renderPretty(
  runResult: RunResult,
  documents?: ReadonlyMap<string, Document>,
  color = false,
): string {
  return prettyFormatter.render(runResult, { color, documents });
}

describe("prettyFormatter", () => {
  it("groups static diagnostics by file and prints a summary", () => {
    expect(renderPretty(result())).toBe(
      'src/a.ts\n  2:3       warning  found something  static-rule\n\n1 problem (1 warning)\n',
    );
  });

  it("reports a clean run", () => {
    const clean = result({
      diagnostics: [],
      summary: { warningCount: 0 },
    });

    expect(renderPretty(clean)).toBe("No issues found in 1 file.\n");
  });

  it("uses match wording for find results", () => {
    const matches = result({
      mode: "find",
      diagnostics: [
        {
          ruleId: "find",
          severity: "info",
          message: "all uses of Promise.all",
          path: "src/a.ts",
          range: { line: 2, column: 1, endLine: 2, endColumn: 6 },
          score: 0.72,
        },
      ],
      summary: { warningCount: 0, infoCount: 1 },
    });
    const documents = new Map([["src/a.ts", documentOf(4)]]);

    expect(renderPretty(matches, documents)).toContain("1 match (1 info)");
  });

  it("reports a clean find run", () => {
    const clean = result({
      mode: "find",
      diagnostics: [],
      summary: { warningCount: 0 },
    });

    expect(renderPretty(clean)).toBe("No matches in 1 file.\n");
  });

  it("lists internal issues and skipped files", () => {
    const withTool = result({
      diagnostics: [],
      toolDiagnostics: [{ message: "rule \"x\" failed: boom", path: "a.ts" }],
      summary: { warningCount: 0, filesSkipped: 2 },
    });

    expect(renderPretty(withTool)).toBe(
      'flint: 1 internal issue\n  a.ts: rule "x" failed: boom\n\n2 files skipped.\n',
    );
  });

  it("renders AI findings as code frames", () => {
    const withAi = result({
      diagnostics: [aiFinding()],
      summary: { errorCount: 1, warningCount: 0 },
    });
    const documents = new Map([["src/a.ts", documentOf(6)]]);

    expect(renderPretty(withAi, documents)).toBe(
      [
        "src/a.ts",
        "   1 │ line 1",
        "   2 │ line 2",
        "   3 │ line 3",
        '     │   error    Jev "no-sensitive-logging": line 3 (p=0.91)  no-sensitive-logging  0.79',
        "   4 │ line 4",
        "   5 │ line 5",
        "",
        "1 problem (1 error)",
      ].join("\n") + "\n",
    );
  });

  it("keeps static diagnostics before AI frames", () => {
    const mixed = result({
      diagnostics: [
        {
          ruleId: "static-rule",
          severity: "warning",
          message: "static hit",
          path: "src/a.ts",
          range: { line: 1, column: 1 },
        },
        aiFinding(),
      ],
      summary: { errorCount: 1, warningCount: 1 },
    });
    const documents = new Map([["src/a.ts", documentOf(6)]]);
    const output = renderPretty(mixed, documents);

    expect(output.indexOf("static hit")).toBeLessThan(output.indexOf("line 3"));
  });

  it("merges contiguous findings into one run and clamps windows", () => {
    const merged = result({
      diagnostics: [
        aiFinding({ range: { line: 3, column: 1, endLine: 3, endColumn: 7 } }),
        aiFinding({
          message: 'Jev "no-sensitive-logging": line 4 (p=0.5)',
          range: { line: 4, column: 1, endLine: 4, endColumn: 7 },
          score: 0.4,
        }),
      ],
      summary: { errorCount: 2, warningCount: 0 },
    });
    const documents = new Map([["src/a.ts", documentOf(8)]]);
    const output = renderPretty(merged, documents);

    expect(output).toContain("   3 │ line 3");
    expect(output).toContain("   4 │ line 4");
    expect(output).toContain("   6 │ line 6");
    expect(output).not.toContain("   7 │ line 7");
    expect(output.match(/│   error/g)).toHaveLength(2);
  });

  it("merges overlapping windows and clamps at file edges", () => {
    const spread = result({
      diagnostics: [
        aiFinding({ range: { line: 1, column: 1, endLine: 1, endColumn: 7 } }),
        aiFinding({
          message: 'Jev "no-sensitive-logging": line 6 (p=0.5)',
          range: { line: 6, column: 1, endLine: 6, endColumn: 7 },
          score: 0.4,
        }),
      ],
      summary: { errorCount: 2, warningCount: 0 },
    });
    const documents = new Map([["src/a.ts", documentOf(6)]]);
    const output = renderPretty(spread, documents);

    expect(output).toContain("   1 │ line 1");
    expect(output).toContain("   6 │ line 6");
    expect(output).not.toContain("   7 │");
    expect(output.match(/│   error/g)).toHaveLength(2);
  });

  it("falls back to a classic line for findings over the frame limit", () => {
    const wide = result({
      diagnostics: [
        aiFinding({
          range: { line: 1, column: 1, endLine: 60, endColumn: 1 },
        }),
      ],
      summary: { errorCount: 1, warningCount: 0 },
    });
    const documents = new Map([["src/a.ts", documentOf(100)]]);
    const output = renderPretty(wide, documents);

    expect(output).toContain("  1:1");
    expect(output).toContain("no-sensitive-logging  0.79");
    expect(output).not.toContain("│");
  });

  it("falls back to a classic line when the document is unavailable", () => {
    const withAi = result({
      diagnostics: [aiFinding()],
      summary: { errorCount: 1, warningCount: 0 },
    });

    expect(renderPretty(withAi)).toBe(
      [
        "src/a.ts",
        '  3:1       error    Jev "no-sensitive-logging": line 3 (p=0.91)  no-sensitive-logging  0.79',
        "",
        "1 problem (1 error)",
      ].join("\n") + "\n",
    );
  });

  it("colors finding lines, gutters, and scores by band", () => {
    const high = result({
      diagnostics: [aiFinding({ score: 0.95 })],
      summary: { errorCount: 1, warningCount: 0 },
    });
    const documents = new Map([["src/a.ts", documentOf(6)]]);
    const output = renderPretty(high, documents, true);

    expect(output).toContain(styleText("dim", " 3"));
    expect(output).toContain(styleText(["redBright", "bold"], "line 3"));
    expect(output).toContain(styleText(["redBright", "bold"], "0.95"));
    expect(output).toContain(styleText("bold", "src/a.ts"));
  });

  it("lists notices dim and prints the AI summary", () => {
    const withNotice = result({
      diagnostics: [],
      notices: [
        {
          path: "big.ts",
          ruleId: "jev",
          message: "skipped: file is 200000 bytes, above maxFileBytes (131072)",
        },
      ],
      summary: {
        warningCount: 0,
        ai: {
          requests: 2,
          inputTokens: 30,
          outputTokens: 10,
          cost: 0.0001,
        },
      },
    });

    expect(renderPretty(withNotice)).toBe(
      [
        "flint: 1 notice",
        "  big.ts: skipped: file is 200000 bytes, above maxFileBytes (131072)",
        "",
        "No issues found in 1 file.",
        "AI: 2 requests, 30 input tokens, 10 output tokens, $0.0001",
      ].join("\n") + "\n",
    );
  });
});

describe("jsonFormatter", () => {
  it("emits a versioned payload with notices and score", () => {
    const parsed = JSON.parse(
      jsonFormatter.render(
        result({
          diagnostics: [aiFinding()],
          notices: [{ message: "skipped" }],
          summary: { errorCount: 1, warningCount: 0 },
        }),
        { color: false },
      ),
    );

    expect(parsed.version).toBe(1);
    expect(parsed.diagnostics).toHaveLength(1);
    expect(parsed.diagnostics[0].score).toBe(0.79);
    expect(parsed.notices).toEqual([{ message: "skipped" }]);
    expect(parsed.summary.errorCount).toBe(1);
    expect(parsed.toolDiagnostics).toEqual([]);
  });
});

const write = (): void => {};

describe("reportResult", () => {
  it("returns 0 for warnings without a limit", () => {
    expect(reportResult(result(), { formatter: jsonFormatter, color: false, write })).toBe(0);
  });

  it("returns 1 when maxWarnings is exceeded", () => {
    expect(
      reportResult(result(), {
        formatter: jsonFormatter,
        color: false,
        write,
        maxWarnings: 0,
      }),
    ).toBe(1);
  });

  it("returns 1 for errors and internal issues", () => {
    const withError = result({ summary: { errorCount: 1, warningCount: 0 } });
    expect(reportResult(withError, { formatter: jsonFormatter, color: false, write })).toBe(1);

    const withTool = result({ toolDiagnostics: [{ message: "boom" }] });
    expect(reportResult(withTool, { formatter: jsonFormatter, color: false, write })).toBe(1);
  });
});
