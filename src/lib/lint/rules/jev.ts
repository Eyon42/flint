import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  getJevClient,
  type JevChoiceQuestion,
  type JevNoulQuestion,
  type JevResponse,
  type JevScoreQuestion,
} from "../../ai/jev.js";
import { ConfigError } from "../../errors.js";
import { jevCacheDir } from "../cache.js";
import type { Document, Rule, Severity } from "../types.js";
import {
  isJevResponse,
  runJevFunnel,
  type JevFunnelCache,
} from "./jev-funnel.js";
import {
  PRESET_NAMES,
  presets,
  type JevPresetName,
} from "./presets/index.js";

export {
  DEFAULT_CONTEXT_TOKENS,
  DEFAULT_LOCATE_MAX_CHUNKS,
  DEFAULT_RESERVED_OUTPUT_TOKENS,
  DEFAULT_NOUL_THRESHOLD,
  resolveLocate,
  toQuestion,
} from "./jev-funnel.js";
export type {
  JevFindingChunk,
  JevFindingData,
  JevFunnelCache,
  JevFunnelInput,
} from "./jev-funnel.js";

export interface JevReportSpec {
  message?: string;
  severity?: Severity;
  min?: number;
  max?: number;
  is?: string[];
  not?: string[];
}

export interface JevLocateOptions {
  /** Lines per section when localizing (default 15). */
  chunkLines?: number;
  /** Report lines with probability >= lineMin (default 0.2). */
  lineMin?: number;
  /** Cap reported lines per question per file (default 20). */
  maxLines?: number;
  /** Cap chunks per file; adjacent chunks merge to satisfy it (default 12). */
  maxChunks?: number;
}

export type JevRuleQuestion =
  | (JevNoulQuestion & {
      report: JevReportSpec;
      locate?: boolean | JevLocateOptions;
    })
  | (JevChoiceQuestion & { report: JevReportSpec })
  | (JevScoreQuestion & { report: JevReportSpec });

export interface JevRuleOptions {
  /**
   * Named built-in question presets. They are resolved into `questions`, in
   * order, before validation; later presets win on id conflicts.
   */
  presets?: JevPresetName[];
  questions?: Record<string, JevRuleQuestion>;
  model?: string;
  maxFileBytes?: number;
  cache?: boolean;
  /** Jev context window in tokens (default 32768). */
  contextTokens?: number;
  /** Tokens reserved for answers inside the context window (default 2048). */
  reservedOutputTokens?: number;
}

const RULE_ID = "jev";
const DEFAULT_SEVERITY: Severity = "warning";
const DEFAULT_MAX_FILE_BYTES = 131_072;
const SEVERITIES = new Set<Severity>(["error", "warning", "info"]);
const REPORT_KEYS = new Set(["message", "severity", "min", "max", "is", "not"]);
const QUESTION_KEYS = new Set([
  "type",
  "instructions",
  "criteria",
  "report",
  "locate",
]);
const LOCATE_KEYS = new Set(["chunkLines", "lineMin", "maxLines", "maxChunks"]);

function configError(message: string): ConfigError {
  return new ConfigError(`rule "${RULE_ID}": ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseStringList(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((item) => typeof item === "string" && item.trim() !== "")
  ) {
    throw configError(`${label} must be a non-empty array of strings`);
  }
  return [...value] as string[];
}

function parseNoulCriteria(
  id: string,
  raw: unknown,
): { true: string; false: string } {
  if (
    !isRecord(raw) ||
    typeof raw.true !== "string" ||
    typeof raw.false !== "string"
  ) {
    throw configError(
      `question "${id}": noul criteria must define "true" and "false" strings`,
    );
  }
  return { true: raw.true, false: raw.false };
}

function parseChoiceCriteria(
  id: string,
  raw: unknown,
): Record<string, string | null> {
  if (!isRecord(raw) || Object.keys(raw).length === 0) {
    throw configError(
      `question "${id}": choice criteria must be a non-empty object`,
    );
  }
  const criteria: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value !== null && typeof value !== "string") {
      throw configError(
        `question "${id}": choice criteria "${key}" must be a string or null`,
      );
    }
    criteria[key] = value;
  }
  return criteria;
}

function parseScoreCriteria(id: string, raw: unknown): string[] {
  if (
    !Array.isArray(raw) ||
    raw.length < 2 ||
    !raw.every((item) => typeof item === "string" && item.trim() !== "")
  ) {
    throw configError(
      `question "${id}": score criteria must be an array of at least two strings`,
    );
  }
  return [...raw] as string[];
}

function parseReport(id: string, raw: unknown): JevReportSpec {
  if (raw === undefined) {
    return {};
  }
  if (!isRecord(raw)) {
    throw configError(`question "${id}": "report" must be an object`);
  }

  const report: JevReportSpec = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!REPORT_KEYS.has(key)) {
      throw configError(`question "${id}": unknown report option "${key}"`);
    }
    switch (key) {
      case "message":
        if (typeof value !== "string" || value.trim() === "") {
          throw configError(
            `question "${id}": report "message" must be a non-empty string`,
          );
        }
        report.message = value;
        break;
      case "severity":
        if (typeof value !== "string" || !SEVERITIES.has(value as Severity)) {
          throw configError(
            `question "${id}": report "severity" must be one of error, warning, info`,
          );
        }
        report.severity = value as Severity;
        break;
      case "min":
        if (!isFiniteNumber(value)) {
          throw configError(
            `question "${id}": report "min" must be a finite number`,
          );
        }
        report.min = value;
        break;
      case "max":
        if (!isFiniteNumber(value)) {
          throw configError(
            `question "${id}": report "max" must be a finite number`,
          );
        }
        report.max = value;
        break;
      case "is":
        report.is = parseStringList(value, `question "${id}": report "is"`);
        break;
      case "not":
        report.not = parseStringList(value, `question "${id}": report "not"`);
        break;
      default:
        break;
    }
  }
  return report;
}

function validateNoulReport(id: string, report: JevReportSpec): void {
  if (report.is !== undefined || report.not !== undefined) {
    throw configError(
      `question "${id}": report "is"/"not" only apply to choice questions`,
    );
  }
  for (const key of ["min", "max"] as const) {
    const value = report[key];
    if (value !== undefined && (value < 0 || value > 1)) {
      throw configError(
        `question "${id}": report "${key}" for a noul must be between 0 and 1`,
      );
    }
  }
}

function parseLocate(
  id: string,
  raw: unknown,
): boolean | JevLocateOptions | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw === "boolean") {
    return raw;
  }
  if (!isRecord(raw)) {
    throw configError(
      `question "${id}": "locate" must be a boolean or an options object`,
    );
  }
  for (const key of Object.keys(raw)) {
    if (!LOCATE_KEYS.has(key)) {
      throw configError(`question "${id}": unknown locate option "${key}"`);
    }
  }

  const locate: JevLocateOptions = {};
  if (raw.chunkLines !== undefined) {
    if (
      !Number.isInteger(raw.chunkLines) ||
      (raw.chunkLines as number) < 1
    ) {
      throw configError(
        `question "${id}": locate "chunkLines" must be a positive integer`,
      );
    }
    locate.chunkLines = raw.chunkLines as number;
  }
  if (raw.lineMin !== undefined) {
    if (
      !isFiniteNumber(raw.lineMin) ||
      raw.lineMin < 0 ||
      raw.lineMin > 1
    ) {
      throw configError(
        `question "${id}": locate "lineMin" must be between 0 and 1`,
      );
    }
    locate.lineMin = raw.lineMin;
  }
  if (raw.maxLines !== undefined) {
    if (!Number.isInteger(raw.maxLines) || (raw.maxLines as number) < 1) {
      throw configError(
        `question "${id}": locate "maxLines" must be a positive integer`,
      );
    }
    locate.maxLines = raw.maxLines as number;
  }
  if (raw.maxChunks !== undefined) {
    if (!Number.isInteger(raw.maxChunks) || (raw.maxChunks as number) < 1) {
      throw configError(
        `question "${id}": locate "maxChunks" must be a positive integer`,
      );
    }
    locate.maxChunks = raw.maxChunks as number;
  }
  return locate;
}

function parseQuestion(id: string, raw: unknown): JevRuleQuestion {
  if (!isRecord(raw)) {
    throw configError(`question "${id}" must be an object`);
  }
  for (const key of Object.keys(raw)) {
    if (!QUESTION_KEYS.has(key)) {
      throw configError(`question "${id}": unknown option "${key}"`);
    }
  }

  const instructions = raw.instructions;
  if (typeof instructions !== "string" || instructions.trim() === "") {
    throw configError(`question "${id}": "instructions" must be a non-empty string`);
  }

  const report = parseReport(id, raw.report);
  const locate = parseLocate(id, raw.locate);

  if (locate !== undefined && raw.type !== "noul") {
    throw configError(
      `question "${id}": "locate" only applies to noul questions`,
    );
  }

  switch (raw.type) {
    case "noul": {
      const criteria =
        raw.criteria === undefined
          ? undefined
          : parseNoulCriteria(id, raw.criteria);
      validateNoulReport(id, report);
      const question: JevNoulQuestion & {
        report: JevReportSpec;
        locate?: boolean | JevLocateOptions;
      } = { type: "noul", instructions, report };
      if (criteria !== undefined) {
        question.criteria = criteria;
      }
      if (locate !== undefined) {
        question.locate = locate;
      }
      return question;
    }
    case "choice": {
      const criteria = parseChoiceCriteria(id, raw.criteria);
      if (report.min !== undefined || report.max !== undefined) {
        throw configError(
          `question "${id}": report "min"/"max" only apply to noul and score questions`,
        );
      }
      if (report.is === undefined && report.not === undefined) {
        throw configError(
          `question "${id}": choice questions need report "is" or "not"`,
        );
      }
      return { type: "choice", instructions, criteria, report };
    }
    case "score": {
      const criteria = parseScoreCriteria(id, raw.criteria);
      if (report.is !== undefined || report.not !== undefined) {
        throw configError(
          `question "${id}": report "is"/"not" only apply to choice questions`,
        );
      }
      if (report.min === undefined && report.max === undefined) {
        throw configError(
          `question "${id}": score questions need report "min" or "max"`,
        );
      }
      return { type: "score", instructions, criteria, report };
    }
    default:
      throw configError(
        `question "${id}": "type" must be one of noul, choice, score`,
      );
  }
}

function stripEnabled(raw: Record<string, unknown>): Record<string, unknown> {
  if (raw.enabled === undefined) {
    return raw;
  }
  const { enabled: _enabled, ...rest } = raw;
  return rest;
}

function mergeQuestionRaw(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base, ...override };
  for (const key of ["report", "criteria"] as const) {
    const baseValue = base[key];
    const overrideValue = override[key];
    if (isRecord(baseValue) && isRecord(overrideValue)) {
      merged[key] = { ...baseValue, ...overrideValue };
    }
  }
  if (isRecord(base.locate) && isRecord(override.locate)) {
    merged.locate = { ...base.locate, ...override.locate };
  }
  delete merged.enabled;
  return merged;
}

function parsePresetNames(value: unknown): JevPresetName[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw configError('"presets" must be a non-empty array of preset names');
  }

  const names: JevPresetName[] = [];
  for (const entry of value) {
    if (
      typeof entry !== "string" ||
      !PRESET_NAMES.includes(entry as JevPresetName)
    ) {
      throw configError(
        `unknown preset ${JSON.stringify(entry)}; expected one of ${PRESET_NAMES.join(", ")}`,
      );
    }
    const name = entry as JevPresetName;
    if (!names.includes(name)) {
      names.push(name);
    }
  }
  return names;
}

export function parseJevRuleOptions(value: unknown): JevRuleOptions {
  if (!isRecord(value)) {
    throw configError("options must be an object");
  }
  for (const key of Object.keys(value)) {
    if (
      ![
        "presets",
        "questions",
        "model",
        "maxFileBytes",
        "cache",
        "contextTokens",
        "reservedOutputTokens",
      ].includes(key)
    ) {
      throw configError(`unknown option "${key}"`);
    }
  }
  if (value.model !== undefined && typeof value.model !== "string") {
    throw configError('"model" must be a string');
  }
  if (value.cache !== undefined && typeof value.cache !== "boolean") {
    throw configError('"cache" must be a boolean');
  }
  if (value.maxFileBytes !== undefined) {
    if (
      !Number.isInteger(value.maxFileBytes) ||
      (value.maxFileBytes as number) < 1
    ) {
      throw configError('"maxFileBytes" must be a positive integer');
    }
  }
  for (const key of ["contextTokens", "reservedOutputTokens"] as const) {
    if (value[key] !== undefined) {
      if (!Number.isInteger(value[key]) || (value[key] as number) < 1) {
        throw configError(`"${key}" must be a positive integer`);
      }
    }
  }

  const contextTokens =
    Number.isInteger(value.contextTokens) && typeof value.contextTokens === "number"
      ? value.contextTokens
      : undefined;
  const reservedOutputTokens =
    Number.isInteger(value.reservedOutputTokens) &&
    typeof value.reservedOutputTokens === "number"
      ? value.reservedOutputTokens
      : undefined;
  if (
    contextTokens !== undefined &&
    reservedOutputTokens !== undefined &&
    reservedOutputTokens >= contextTokens
  ) {
    throw configError('"reservedOutputTokens" must be smaller than "contextTokens"');
  }

  const options: JevRuleOptions = {};
  if (typeof value.model === "string") {
    options.model = value.model;
  }
  if (typeof value.cache === "boolean") {
    options.cache = value.cache;
  }
  if (Number.isInteger(value.maxFileBytes)) {
    options.maxFileBytes = value.maxFileBytes as number;
  }
  if (contextTokens !== undefined) {
    options.contextTokens = contextTokens;
  }
  if (reservedOutputTokens !== undefined) {
    options.reservedOutputTokens = reservedOutputTokens;
  }

  const presetNames = parsePresetNames(value.presets);

  if (value.questions !== undefined && !isRecord(value.questions)) {
    throw configError('"questions" must be an object');
  }
  const entries: [string, unknown][] = isRecord(value.questions)
    ? Object.entries(value.questions)
    : [];

  if (
    value.questions !== undefined &&
    entries.length === 0 &&
    presetNames.length === 0
  ) {
    throw configError('"questions" must define at least one question');
  }
  if (presetNames.length === 0 && entries.length === 0) {
    return options;
  }

  const rawQuestions: Record<string, unknown> = {};
  for (const name of presetNames) {
    Object.assign(rawQuestions, presets[name]);
  }

  for (const [id, raw] of entries) {
    const base = rawQuestions[id] as Record<string, unknown> | undefined;
    const disabled = raw === false || (isRecord(raw) && raw.enabled === false);
    if (disabled) {
      if (base === undefined) {
        throw configError(
          `question "${id}": cannot disable a question that is not defined`,
        );
      }
      delete rawQuestions[id];
      continue;
    }
    if (!isRecord(raw)) {
      throw configError(`question "${id}" must be an object or false`);
    }
    rawQuestions[id] =
      base === undefined ? stripEnabled(raw) : mergeQuestionRaw(base, raw);
  }

  if (Object.keys(rawQuestions).length === 0) {
    throw configError('"questions" disabled every question');
  }

  const questions: Record<string, JevRuleQuestion> = {};
  for (const [id, raw] of Object.entries(rawQuestions)) {
    questions[id] = parseQuestion(id, raw);
  }
  options.questions = questions;
  return options;
}

function createDiskCache(cwd: string): JevFunnelCache {
  const root = jevCacheDir(cwd);
  return {
    async get(key) {
      try {
        const raw = await readFile(path.join(root, `${key}.json`), "utf8");
        const parsed: unknown = JSON.parse(raw);
        return isJevResponse(parsed) ? (parsed as JevResponse) : undefined;
      } catch {
        return undefined;
      }
    },
    async set(key, response) {
      try {
        await mkdir(root, { recursive: true });
        await writeFile(
          path.join(root, `${key}.json`),
          JSON.stringify(response),
          "utf8",
        );
      } catch {
        // Caching is best-effort; a failed write never fails the run.
      }
    },
  };
}

export const jevRule: Rule = {
  meta: {
    id: RULE_ID,
    description:
      "Asks TypeSafe Jev decisions about each document through the OpenRouter Decisions API",
    defaultSeverity: DEFAULT_SEVERITY,
  },
  validateOptions(options) {
    parseJevRuleOptions(options);
  },
  async check(document: Document, context) {
    const options = parseJevRuleOptions(context.options);
    if (!options.questions) {
      return { diagnostics: [] };
    }

    const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    const bytes = Buffer.byteLength(document.text, "utf8");
    if (bytes > maxFileBytes) {
      return {
        diagnostics: [],
        notices: [
          `skipped: file is ${bytes} bytes, above maxFileBytes (${maxFileBytes})`,
        ],
      };
    }

    const client = getJevClient(options.model);
    const cache = options.cache ? createDiskCache(context.cwd) : undefined;
    const notices: string[] = [];
    const diagnostics = await runJevFunnel({
      document,
      options,
      client,
      cache,
      onNotice: (message) => notices.push(message),
    });
    return notices.length > 0 ? { diagnostics, notices } : { diagnostics };
  },
};
