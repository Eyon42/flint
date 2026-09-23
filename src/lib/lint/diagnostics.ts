import type { Diagnostic } from "./types.js";

function compareStrings(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

function compareDiagnostics(a: Diagnostic, b: Diagnostic): number {
  return (
    compareStrings(a.path, b.path) ||
    a.range.line - b.range.line ||
    a.range.column - b.range.column ||
    (a.range.endLine ?? 0) - (b.range.endLine ?? 0) ||
    (a.range.endColumn ?? 0) - (b.range.endColumn ?? 0) ||
    compareStrings(a.ruleId, b.ruleId) ||
    compareStrings(a.message, b.message)
  );
}

function diagnosticKey(diagnostic: Diagnostic): string {
  return [
    diagnostic.ruleId,
    diagnostic.path,
    diagnostic.range.line,
    diagnostic.range.column,
    diagnostic.range.endLine ?? "",
    diagnostic.range.endColumn ?? "",
    diagnostic.message,
  ].join("\u0000");
}

export function finalizeDiagnostics(
  diagnostics: readonly Diagnostic[],
): Diagnostic[] {
  const seen = new Set<string>();
  const unique: Diagnostic[] = [];
  for (const diagnostic of diagnostics) {
    const key = diagnosticKey(diagnostic);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(diagnostic);
    }
  }
  return unique.toSorted(compareDiagnostics);
}

export interface SeverityCounts {
  errorCount: number;
  warningCount: number;
  infoCount: number;
}

export function countSeverities(
  diagnostics: readonly Diagnostic[],
): SeverityCounts {
  let errorCount = 0;
  let warningCount = 0;
  let infoCount = 0;

  for (const diagnostic of diagnostics) {
    switch (diagnostic.severity) {
      case "error":
        errorCount += 1;
        break;
      case "warning":
        warningCount += 1;
        break;
      case "info":
        infoCount += 1;
        break;
    }
  }

  return { errorCount, warningCount, infoCount };
}
