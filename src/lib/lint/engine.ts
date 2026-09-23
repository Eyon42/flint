import { defaultConcurrency, mapLimit } from "./concurrency.js";
import type { ResolvedRule } from "./rules/index.js";
import type {
  ContentProvider,
  Diagnostic,
  Document,
  Notice,
  RuleContext,
  Target,
  ToolDiagnostic,
} from "./types.js";

export interface EngineOptions {
  targets: readonly Target[];
  provider: ContentProvider;
  rules: readonly ResolvedRule[];
  cwd: string;
  concurrency?: number;
}

export interface EngineResult {
  diagnostics: Diagnostic[];
  toolDiagnostics: ToolDiagnostic[];
  notices: Notice[];
  filesLinted: number;
  filesSkipped: number;
  durationMs: number;
  scoredDocuments: ReadonlyMap<string, Document>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runEngine(options: EngineOptions): Promise<EngineResult> {
  const startedAt = Date.now();
  const diagnostics: Diagnostic[] = [];
  const toolDiagnostics: ToolDiagnostic[] = [];
  const notices: Notice[] = [];
  const scoredDocuments = new Map<string, Document>();
  let filesLinted = 0;
  let filesSkipped = 0;

  await mapLimit(
    options.targets,
    options.concurrency ?? defaultConcurrency(),
    async (target) => {
      let document;
      try {
        document = await options.provider.read(target);
      } catch (error) {
        toolDiagnostics.push({
          path: target.path,
          message: `failed to read: ${errorMessage(error)}`,
        });
        return;
      }

      if (!document) {
        filesSkipped += 1;
        return;
      }
      filesLinted += 1;

      for (const resolved of options.rules) {
        const context: RuleContext = { cwd: options.cwd, options: resolved.options };
        try {
          const result = await resolved.rule.check(document, context);
          const found = Array.isArray(result) ? result : result.diagnostics;
          if (!Array.isArray(result) && result.notices) {
            for (const message of result.notices) {
              notices.push({
                path: target.path,
                ruleId: resolved.rule.meta.id,
                message,
              });
            }
          }
          for (const diagnostic of found) {
            const normalized =
              resolved.severity === undefined ||
              diagnostic.severity === resolved.severity
                ? diagnostic
                : { ...diagnostic, severity: resolved.severity };
            diagnostics.push(normalized);
            if (normalized.score !== undefined) {
              scoredDocuments.set(normalized.path, document);
            }
          }
        } catch (error) {
          toolDiagnostics.push({
            path: target.path,
            ruleId: resolved.rule.meta.id,
            message: `rule "${resolved.rule.meta.id}" failed: ${errorMessage(error)}`,
          });
        }
      }
    },
  );

  return {
    diagnostics,
    toolDiagnostics,
    notices,
    filesLinted,
    filesSkipped,
    durationMs: Date.now() - startedAt,
    scoredDocuments,
  };
}
