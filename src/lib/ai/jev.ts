import { createLimiter, type Limiter } from "../lint/concurrency.js";

export const JEV_DEFAULT_BASE_URL = "https://openrouter.ai/api";
export const JEV_DEFAULT_MODEL = "~typesafe/jev-latest";

export interface JevNoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: { true: string; false: string };
}

export interface JevChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string | null>;
}

export interface JevScoreQuestion {
  type: "score";
  instructions: string;
  criteria: string[];
}

export type JevQuestion =
  | JevNoulQuestion
  | JevChoiceQuestion
  | JevScoreQuestion;

export interface JevNoulAnswer {
  type: "noul";
  noul: number;
}

export interface JevChoiceAnswer {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities?: Record<string, number>;
}

export interface JevScoreAnswer {
  type: "score";
  score: number;
  confidence: number;
  probabilities?: Record<string, number>;
  legend?: Record<string, string>;
}

export type JevAnswer = JevNoulAnswer | JevChoiceAnswer | JevScoreAnswer;

export interface JevUsage {
  input_tokens: number;
  output_tokens: number;
  cost?: number;
}

export interface JevResponse {
  id?: string;
  model: string;
  provider?: string;
  answers: Record<string, JevAnswer>;
  usage: JevUsage;
}

export type JevFetch = typeof globalThis.fetch;

export interface JevStats {
  /** HTTP attempts across every client in this process. */
  requests: number;
  /** Decide calls that returned a parsed response. */
  decisions: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

export class JevError extends Error {
  override name = "JevError";
  readonly status: number | undefined;
  readonly detail: string | undefined;

  constructor(
    message: string,
    options: { status?: number; detail?: string; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.status = options.status;
    this.detail = options.detail;
  }
}

/** True when Jev rejected the request because it exceeded the token limit. */
export function isJevTokenLimitError(error: unknown): boolean {
  return (
    error instanceof JevError &&
    error.status === 400 &&
    (error.detail ?? error.message).includes("max_tokens_exceeded")
  );
}

export interface JevClientOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  headers?: Record<string, string>;
  fetch?: JevFetch;
  timeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  /** In-flight decide calls allowed for this client (default 4). */
  maxConcurrency?: number;
  /** HTTP attempts allowed for this client before it throws (default 500). */
  maxRequests?: number;
}

export interface JevDecideRequest {
  state: unknown;
  questions: Record<string, JevQuestion>;
  model?: string;
  sessionId?: string;
  signal?: AbortSignal;
}

export interface JevClient {
  readonly model: string;
  decide(request: JevDecideRequest): Promise<JevResponse>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 250;
const DEFAULT_MAX_CONCURRENCY = 4;
const DEFAULT_MAX_REQUESTS = 500;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 524, 529]);

const stats: JevStats = {
  requests: 0,
  decisions: 0,
  inputTokens: 0,
  outputTokens: 0,
  cost: 0,
};

const clients = new Map<string, JevClient>();

/** Snapshot of Jev usage for the whole process (used by `summary.ai`). */
export function getJevStats(): JevStats {
  return { ...stats };
}

/** Drop accumulated stats and memoized clients (tests, embedded runs). */
export function resetJevState(): void {
  stats.requests = 0;
  stats.decisions = 0;
  stats.inputTokens = 0;
  stats.outputTokens = 0;
  stats.cost = 0;
  clients.clear();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseNumberMap(
  value: unknown,
  label: string,
): Record<string, number> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new JevError(`${label} must be an object of numbers`);
  }
  const entries: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!isNumber(entry)) {
      throw new JevError(`${label}.${key} must be a number`);
    }
    entries[key] = entry;
  }
  return entries;
}

function parseStringMap(
  value: unknown,
  label: string,
): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new JevError(`${label} must be an object of strings`);
  }
  const entries: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      throw new JevError(`${label}.${key} must be a string`);
    }
    entries[key] = entry;
  }
  return entries;
}

function parseUsage(raw: Record<string, unknown>): JevUsage {
  if (!isNumber(raw.input_tokens) || !isNumber(raw.output_tokens)) {
    throw new JevError("Jev response is missing usage token counts");
  }
  const usage: JevUsage = {
    input_tokens: raw.input_tokens,
    output_tokens: raw.output_tokens,
  };
  if (isNumber(raw.cost)) {
    usage.cost = raw.cost;
  }
  return usage;
}

function inferAnswerType(raw: Record<string, unknown>): string {
  if (isNumber(raw.noul)) {
    return "noul";
  }
  if (typeof raw.choice === "string") {
    return "choice";
  }
  if (isNumber(raw.score)) {
    return "score";
  }
  throw new JevError("Jev answer is missing a question type");
}

function parseAnswer(id: string, raw: unknown): JevAnswer {
  if (!isRecord(raw)) {
    throw new JevError(`Jev answer "${id}" must be an object`);
  }

  const type = typeof raw.type === "string" ? raw.type : inferAnswerType(raw);

  if (type === "noul") {
    if (!isNumber(raw.noul)) {
      throw new JevError(`Jev answer "${id}" is missing a numeric "noul"`);
    }
    return { type: "noul", noul: raw.noul };
  }

  if (type === "choice") {
    if (typeof raw.choice !== "string" || !isNumber(raw.confidence)) {
      throw new JevError(
        `Jev answer "${id}" needs a "choice" string and a "confidence" number`,
      );
    }
    const answer: JevChoiceAnswer = {
      type: "choice",
      choice: raw.choice,
      confidence: raw.confidence,
    };
    const probabilities = parseNumberMap(
      raw.probabilities,
      `Jev answer "${id}" probabilities`,
    );
    if (probabilities) {
      answer.probabilities = probabilities;
    }
    return answer;
  }

  if (type === "score") {
    if (!isNumber(raw.score) || !isNumber(raw.confidence)) {
      throw new JevError(
        `Jev answer "${id}" needs a "score" number and a "confidence" number`,
      );
    }
    const answer: JevScoreAnswer = {
      type: "score",
      score: raw.score,
      confidence: raw.confidence,
    };
    const probabilities = parseNumberMap(
      raw.probabilities,
      `Jev answer "${id}" probabilities`,
    );
    if (probabilities) {
      answer.probabilities = probabilities;
    }
    const legend = parseStringMap(raw.legend, `Jev answer "${id}" legend`);
    if (legend) {
      answer.legend = legend;
    }
    return answer;
  }

  throw new JevError(`Jev answer "${id}" has unknown type "${type}"`);
}

function parseResponse(raw: unknown, fallbackModel: string): JevResponse {
  if (!isRecord(raw) || !isRecord(raw.answers) || !isRecord(raw.usage)) {
    throw new JevError(
      "unexpected response shape from the OpenRouter Decisions API",
    );
  }

  const answers: Record<string, JevAnswer> = {};
  for (const [id, answer] of Object.entries(raw.answers)) {
    answers[id] = parseAnswer(id, answer);
  }

  const response: JevResponse = {
    answers,
    model: typeof raw.model === "string" ? raw.model : fallbackModel,
    usage: parseUsage(raw.usage),
  };
  if (typeof raw.id === "string") {
    response.id = raw.id;
  }
  if (typeof raw.provider === "string") {
    response.provider = raw.provider;
  }
  return response;
}

async function parseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new JevError("Jev response was not valid JSON", { cause: error });
  }
}

async function readErrorDetail(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.length > 300 ? `${text.slice(0, 300)}...` : text;
  } catch {
    return "";
  }
}

function retryDelayMs(
  response: Response,
  attempt: number,
  fallbackMs: number,
): number {
  const header = response.headers.get("retry-after");
  if (header) {
    const seconds = Number.parseFloat(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1000;
    }
  }
  return fallbackMs * 2 ** attempt;
}

export function createJevClient(options: JevClientOptions = {}): JevClient {
  const apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new JevError(
      "OPENROUTER_API_KEY is not set; Jev decisions are served by the OpenRouter Decisions API",
    );
  }

  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new JevError("global fetch is unavailable; Node.js >= 22 is required");
  }

  const baseUrl = (options.baseUrl ?? JEV_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const model =
    options.model || process.env.OPENROUTER_DECISIONS_MODEL || JEV_DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const fallbackDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS;
  const limiter: Limiter = createLimiter(
    options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
  );

  let attempts = 0;

  return {
    model,
    async decide(request) {
      return limiter(async () => {
        const body: Record<string, unknown> = {
          model: request.model ?? model,
          state: request.state,
          questions: request.questions,
        };
        if (request.sessionId !== undefined) {
          body.session_id = request.sessionId;
        }
        const url = `${baseUrl}/alpha/decisions`;

        for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
          if (attempts >= maxRequests) {
            throw new JevError(
              `Jev request budget exceeded (maxRequests: ${maxRequests})`,
            );
          }
          attempts += 1;
          stats.requests += 1;

          const timeout = AbortSignal.timeout(timeoutMs);
          const signal = request.signal
            ? AbortSignal.any([request.signal, timeout])
            : timeout;

          let response: Response;
          try {
            response = await fetchImpl(url, {
              method: "POST",
              headers: {
                authorization: `Bearer ${apiKey}`,
                "content-type": "application/json",
                ...options.headers,
              },
              body: JSON.stringify(body),
              signal,
            });
          } catch (error) {
            if (request.signal?.aborted) {
              throw new JevError("Jev request aborted by the caller", {
                cause: error,
              });
            }
            if (timeout.aborted) {
              throw new JevError(`Jev request timed out after ${timeoutMs}ms`, {
                cause: error,
              });
            }
            if (attempt >= maxRetries) {
              throw new JevError(`Jev request failed: ${errorMessage(error)}`, {
                cause: error,
              });
            }
            await delay(fallbackDelayMs * 2 ** attempt);
            continue;
          }

          if (response.ok) {
            const parsed = parseResponse(await parseJson(response), model);
            stats.decisions += 1;
            stats.inputTokens += parsed.usage.input_tokens;
            stats.outputTokens += parsed.usage.output_tokens;
            if (parsed.usage.cost !== undefined) {
              stats.cost += parsed.usage.cost;
            }
            return parsed;
          }

          const detail = await readErrorDetail(response);
          if (RETRYABLE_STATUSES.has(response.status) && attempt < maxRetries) {
            await delay(retryDelayMs(response, attempt, fallbackDelayMs));
            continue;
          }
          throw new JevError(
            `Jev request failed with status ${response.status}${detail ? `: ${detail}` : ""}`,
            { status: response.status, detail },
          );
        }

        throw new JevError("Jev request failed");
      });
    },
  };
}

/**
 * Returns the shared client for a model, creating it on first use. Limits and
 * stats span the whole run instead of one client per document.
 */
export function getJevClient(model?: string): JevClient {
  const resolved =
    model || process.env.OPENROUTER_DECISIONS_MODEL || JEV_DEFAULT_MODEL;
  let client = clients.get(resolved);
  if (!client) {
    client = createJevClient({ model: resolved });
    clients.set(resolved, client);
  }
  return client;
}
