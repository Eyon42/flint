export type Severity = "error" | "warning" | "info";

export interface Target {
  path: string;
  source: string;
}

export interface Document {
  path: string;
  text: string;
  lineStarts: number[];
  language?: string;
}

export interface DiagnosticRange {
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
}

export interface Diagnostic {
  ruleId: string;
  severity: Severity;
  message: string;
  path: string;
  range: DiagnosticRange;
  /**
   * AI findings only: the probability that the rule applies (noul times the
   * chosen-option probability). Formatters and JSON use `score !== undefined`
   * to tell AI findings apart from static ones.
   */
  score?: number;
  data?: unknown;
}

export interface ToolDiagnostic {
  message: string;
  path?: string;
  ruleId?: string;
}

export interface Notice {
  message: string;
  path?: string;
  ruleId?: string;
}

export interface AiSummary {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

export interface RunSummary {
  filesConsidered: number;
  filesLinted: number;
  filesSkipped: number;
  errorCount: number;
  warningCount: number;
  infoCount: number;
  durationMs: number;
  ai?: AiSummary;
}

export interface RunResult {
  diagnostics: Diagnostic[];
  toolDiagnostics: ToolDiagnostic[];
  notices: Notice[];
  summary: RunSummary;
  /** Command that produced the result; drives summary wording. */
  mode?: "lint" | "find";
}

export interface RuleMeta {
  id: string;
  description: string;
  defaultSeverity: Severity;
}

export interface RuleContext {
  cwd: string;
  options: unknown;
}

export interface RuleCheckResult {
  diagnostics: Diagnostic[];
  notices?: string[];
}

export interface Rule {
  meta: RuleMeta;
  validateOptions?(options: unknown): void;
  check(
    document: Document,
    context: RuleContext,
  ):
    | RuleCheckResult
    | Diagnostic[]
    | Promise<RuleCheckResult | Diagnostic[]>;
}

export interface RenderOptions {
  color: boolean;
  documents?: ReadonlyMap<string, Document>;
}

export interface Formatter {
  name: string;
  render(result: RunResult, options: RenderOptions): string;
}

export interface ContentProvider {
  read(target: Target): Promise<Document | null>;
}
