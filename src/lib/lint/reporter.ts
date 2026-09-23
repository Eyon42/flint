import type { Document, Formatter, RunResult } from "./types.js";

export interface ReporterOptions {
  formatter: Formatter;
  color: boolean;
  write: (text: string) => void;
  maxWarnings?: number;
  documents?: ReadonlyMap<string, Document>;
}

export function reportResult(
  result: RunResult,
  options: ReporterOptions,
): number {
  options.write(
    options.formatter.render(result, {
      color: options.color,
      documents: options.documents,
    }),
  );

  const failed = result.summary.errorCount > 0 || result.toolDiagnostics.length > 0;
  const warningsExceeded =
    options.maxWarnings !== undefined &&
    result.summary.warningCount > options.maxWarnings;

  return failed || warningsExceeded ? 1 : 0;
}
