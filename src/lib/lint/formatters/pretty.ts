import { styleText } from "node:util";
import { lineCount, lineText } from "../documents.js";
import type { Diagnostic, Document, Formatter, Severity } from "../types.js";

const AI_CONTEXT_LINES = 2;
const AI_MERGE_GAP = 1;
const AI_FRAME_MAX_LINES = 40;
const GUTTER_MIN_WIDTH = 2;

function pluralize(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

function formatSeverity(severity: Severity, color: boolean): string {
  const label = severity.padEnd(7);
  if (!color) {
    return label;
  }
  if (severity === "error") {
    return styleText("red", label);
  }
  if (severity === "warning") {
    return styleText("yellow", label);
  }
  return styleText("blue", label);
}

function shade(score: number, text: string, color: boolean): string {
  if (!color) {
    return text;
  }
  if (score >= 0.9) {
    return styleText(["redBright", "bold"], text);
  }
  if (score >= 0.8) {
    return styleText("redBright", text);
  }
  if (score >= 0.7) {
    return styleText(["red", "bold"], text);
  }
  return styleText("red", text);
}

function spanStart(diagnostic: Diagnostic): number {
  return diagnostic.range.line;
}

function spanEnd(diagnostic: Diagnostic): number {
  return diagnostic.range.endLine ?? diagnostic.range.line;
}

function spanLength(diagnostic: Diagnostic): number {
  return spanEnd(diagnostic) - spanStart(diagnostic) + 1;
}

function classicLine(
  diagnostic: Diagnostic,
  color: boolean,
  includeScore = false,
): string {
  const location =
    `${diagnostic.range.line}:${diagnostic.range.column}`.padEnd(8);
  const rule = color ? styleText("dim", diagnostic.ruleId) : diagnostic.ruleId;
  const score =
    includeScore && diagnostic.score !== undefined
      ? `  ${shade(diagnostic.score, diagnostic.score.toFixed(2), color)}`
      : "";
  return `  ${location}  ${formatSeverity(diagnostic.severity, color)}  ${diagnostic.message}  ${rule}${score}`;
}

interface FrameWindow {
  start: number;
  end: number;
}

function buildWindows(
  findings: readonly Diagnostic[],
  total: number,
): FrameWindow[] {
  if (findings.length === 0) {
    return [];
  }
  const sorted = findings.toSorted((a, b) => spanStart(a) - spanStart(b));

  const runs: FrameWindow[] = [];
  let current: FrameWindow | undefined;
  for (const diagnostic of sorted) {
    const start = spanStart(diagnostic);
    const end = Math.min(spanEnd(diagnostic), total);
    if (current && start - current.end <= AI_MERGE_GAP) {
      current.end = Math.max(current.end, end);
    } else {
      if (current) {
        runs.push(current);
      }
      current = { start, end };
    }
  }
  if (current) {
    runs.push(current);
  }

  const expanded = runs.map((run) => ({
    start: Math.max(1, run.start - AI_CONTEXT_LINES),
    end: Math.min(total, run.end + AI_CONTEXT_LINES),
  }));

  const merged: FrameWindow[] = [];
  for (const window of expanded) {
    const last = merged[merged.length - 1];
    if (last && window.start <= last.end + 1) {
      last.end = Math.max(last.end, window.end);
    } else {
      merged.push({ ...window });
    }
  }
  return merged;
}

function renderCodeLine(
  line: number,
  text: string,
  width: number,
  color: boolean,
  score: number | undefined,
): string {
  const gutter = String(line).padStart(width);
  const gutterText = color ? styleText("dim", gutter) : gutter;
  const body = score === undefined ? text : shade(score, text, color);
  return `  ${gutterText} │ ${body}`;
}

function renderAnnotation(
  diagnostic: Diagnostic,
  width: number,
  color: boolean,
): string {
  const pad = " ".repeat(width);
  const rule = color ? styleText("dim", diagnostic.ruleId) : diagnostic.ruleId;
  const score =
    diagnostic.score === undefined
      ? ""
      : shade(diagnostic.score, diagnostic.score.toFixed(2), color);
  return `  ${pad} │   ${formatSeverity(diagnostic.severity, color)}  ${diagnostic.message}  ${rule}  ${score}`;
}

function renderFrames(
  document: Document,
  findings: readonly Diagnostic[],
  color: boolean,
): string[] {
  const total = lineCount(document);
  const lines: string[] = [];
  for (const window of buildWindows(findings, total)) {
    const width = Math.max(GUTTER_MIN_WIDTH, String(window.end).length);
    for (let line = window.start; line <= window.end; line += 1) {
      const covering = findings.filter(
        (diagnostic) =>
          spanStart(diagnostic) <= line && line <= spanEnd(diagnostic),
      );
      const score =
        covering.length > 0
          ? Math.max(...covering.map((diagnostic) => diagnostic.score ?? 0))
          : undefined;
      lines.push(
        renderCodeLine(line, lineText(document, line), width, color, score),
      );
      for (const diagnostic of covering) {
        if (spanStart(diagnostic) === line) {
          lines.push(renderAnnotation(diagnostic, width, color));
        }
      }
    }
  }
  return lines;
}

export const prettyFormatter: Formatter = {
  name: "pretty",
  render(result, options) {
    const { color, documents } = options;
    const lines: string[] = [];
    const byFile = new Map<string, Diagnostic[]>();
    for (const diagnostic of result.diagnostics) {
      const existing = byFile.get(diagnostic.path);
      if (existing) {
        existing.push(diagnostic);
      } else {
        byFile.set(diagnostic.path, [diagnostic]);
      }
    }

    for (const [file, diagnostics] of byFile) {
      lines.push(color ? styleText("bold", file) : file);

      const staticFindings = diagnostics.filter(
        (diagnostic) => diagnostic.score === undefined,
      );
      const aiFindings = diagnostics.filter(
        (diagnostic) => diagnostic.score !== undefined,
      );

      for (const diagnostic of staticFindings) {
        lines.push(classicLine(diagnostic, color));
      }

      const document = documents?.get(file);
      if (!document) {
        for (const diagnostic of aiFindings) {
          lines.push(classicLine(diagnostic, color, true));
        }
      } else {
        const total = lineCount(document);
        const framed: Diagnostic[] = [];
        const overflow: Diagnostic[] = [];
        for (const diagnostic of aiFindings) {
          if (spanLength(diagnostic) > AI_FRAME_MAX_LINES || spanStart(diagnostic) > total) {
            overflow.push(diagnostic);
          } else {
            framed.push(diagnostic);
          }
        }
        for (const diagnostic of overflow) {
          lines.push(classicLine(diagnostic, color, true));
        }
        lines.push(...renderFrames(document, framed, color));
      }

      lines.push("");
    }

    const noticeCount = result.notices.length;
    if (noticeCount > 0) {
      const header = `flint: ${pluralize(noticeCount, "notice")}`;
      lines.push(color ? styleText("dim", header) : header);
      for (const notice of result.notices) {
        const text = `  ${notice.path ? `${notice.path}: ` : ""}${notice.message}`;
        lines.push(color ? styleText("dim", text) : text);
      }
      lines.push("");
    }

    const toolCount = result.toolDiagnostics.length;
    if (toolCount > 0) {
      const header = `flint: ${pluralize(toolCount, "internal issue")}`;
      lines.push(color ? styleText("red", header) : header);
      for (const tool of result.toolDiagnostics) {
        lines.push(`  ${tool.path ? `${tool.path}: ` : ""}${tool.message}`);
      }
      lines.push("");
    }

    const { errorCount, warningCount, infoCount, filesLinted, filesSkipped } =
      result.summary;
    const total = errorCount + warningCount + infoCount;
    const find = result.mode === "find";

    if (total === 0 && toolCount === 0) {
      lines.push(
        find
          ? `No matches in ${pluralize(filesLinted, "file")}.`
          : `No issues found in ${pluralize(filesLinted, "file")}.`,
      );
    }
    if (total > 0) {
      const parts: string[] = [];
      if (errorCount > 0) {
        parts.push(pluralize(errorCount, "error"));
      }
      if (warningCount > 0) {
        parts.push(pluralize(warningCount, "warning"));
      }
      if (infoCount > 0) {
        parts.push(pluralize(infoCount, "info"));
      }
      lines.push(
        `${pluralize(total, find ? "match" : "problem")} (${parts.join(", ")})`,
      );
    }
    if (filesSkipped > 0) {
      lines.push(`${pluralize(filesSkipped, "file")} skipped.`);
    }
    if (result.summary.ai) {
      const { requests, inputTokens, outputTokens, cost } = result.summary.ai;
      const text = `AI: ${pluralize(requests, "request")}, ${inputTokens} input tokens, ${outputTokens} output tokens, $${cost.toFixed(4)}`;
      lines.push(color ? styleText("dim", text) : text);
    }

    return `${lines.join("\n")}\n`;
  },
};
