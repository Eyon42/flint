import {
  JevError,
  isJevTokenLimitError,
  type JevAnswer,
  type JevChoiceAnswer,
  type JevClient,
  type JevQuestion,
  type JevResponse,
} from "../../ai/jev.js";
import { lineCount, lineRange, positionAt } from "../documents.js";
import type { Diagnostic, DiagnosticRange, Document, Severity } from "../types.js";
import {
  chunkDocument,
  renderChunkCriteria,
  renderLineCriteria,
  renderLines,
  renderNumberedLines,
  type JevChunk,
} from "./jev-candidates.js";
import {
  batchQuestionGroups,
  fitsBudget,
  partitionParts,
  requestBudgetChars,
  type JevBudget,
  type JevPart,
  type QuestionGroup,
} from "./jev-budget.js";
import { hashRuleset, jevRequestKey } from "./jev-cache.js";
import type {
  JevLocateOptions,
  JevReportSpec,
  JevRuleOptions,
  JevRuleQuestion,
} from "./jev.js";

export const DEFAULT_NOUL_THRESHOLD = 0.8;
export const DEFAULT_SEVERITY: Severity = "warning";
export const DEFAULT_LOCATE_CHUNK_LINES = 15;
export const DEFAULT_LOCATE_LINE_MIN = 0.2;
export const DEFAULT_LOCATE_MAX_LINES = 20;
export const DEFAULT_LOCATE_MAX_CHUNKS = 12;
export const DEFAULT_CONTEXT_TOKENS = 32_768;
export const DEFAULT_RESERVED_OUTPUT_TOKENS = 2_048;

/** How many times the funnel doubles chunk sizes before batching or splitting. */
const CHUNK_GROW_ATTEMPTS = 4;
/** JSON wrapper and metadata slack when reserving room for one question group. */
const PART_OVERHEAD_CHARS = 256;
/** Parts below this size cannot host a useful question, so localization falls back. */
const MIN_PART_CHARS = 1_024;

function localizationNotice(): string {
  return "localization skipped: file is too large for the classify request";
}

export interface JevFunnelCache {
  get(key: string): Promise<JevResponse | undefined>;
  set(key: string, response: JevResponse): Promise<void>;
}

export interface JevFunnelInput {
  document: Document;
  options: JevRuleOptions;
  client: JevClient;
  cache?: JevFunnelCache;
  /** Called when localization is skipped because the request is too large. */
  onNotice?: (message: string) => void;
}

export interface JevFindingChunk {
  key: string;
  lines: [number, number];
  probability: number;
}

export interface JevFindingData {
  questionId: string;
  stage: "document" | "chunk" | "line";
  noul: number;
  chunk?: JevFindingChunk;
  lineProbability?: number;
  confidence?: number;
  model: string;
}

/** State sent to Jev; parts and chunks carry absolute line offsets. */
interface JevState {
  path: string;
  language?: string;
  startLine?: number;
  endLine?: number;
  text: string;
}

interface JevChunkPlan {
  locate: Required<JevLocateOptions>;
  chunks: JevChunk[];
  singleChunk: boolean;
}

interface ClassifyRequest {
  state: JevState;
  questions: Record<string, JevQuestion>;
  part?: JevPart;
}

interface ClassifyPlanning {
  requests: ClassifyRequest[];
  plans: Map<string, JevChunkPlan>;
  localized: boolean;
}

interface AnswerBucket {
  model: string;
  answers: Record<string, JevAnswer>;
}

interface ChosenAnswer {
  answer: JevAnswer;
  model: string;
  bucket: AnswerBucket;
}

interface RefineSource {
  chunk: JevChunk;
  chunkKey: string;
  chunkProbability: number;
  chunkConfidence?: number;
}

interface RefineHit extends RefineSource {
  id: string;
  question: JevRuleQuestion;
  noul: number;
  locate: Required<JevLocateOptions>;
  model: string;
  adjacent: JevChunk[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function answerTypeError(
  id: string,
  expected: string,
  actual: string,
): JevError {
  return new JevError(
    `Jev answered "${id}" with a ${actual} answer, expected ${expected}`,
  );
}

function withinRange(
  value: number,
  min: number | undefined,
  max: number | undefined,
): boolean {
  return (
    (min === undefined || value >= min) && (max === undefined || value <= max)
  );
}

export function shouldReport(
  id: string,
  question: JevRuleQuestion,
  answer: JevAnswer,
): boolean {
  if (question.type === "noul") {
    if (answer.type !== "noul") {
      throw answerTypeError(id, question.type, answer.type);
    }
    const min =
      question.report.min ??
      (question.report.max === undefined ? DEFAULT_NOUL_THRESHOLD : undefined);
    return withinRange(answer.noul, min, question.report.max);
  }

  if (question.type === "choice") {
    if (answer.type !== "choice") {
      throw answerTypeError(id, question.type, answer.type);
    }
    const include = question.report.is;
    const exclude = question.report.not;
    if (include !== undefined && !include.includes(answer.choice)) {
      return false;
    }
    if (exclude !== undefined && exclude.includes(answer.choice)) {
      return false;
    }
    return true;
  }

  if (answer.type !== "score") {
    throw answerTypeError(id, question.type, answer.type);
  }
  return withinRange(answer.score, question.report.min, question.report.max);
}

export function resolveLocate(
  locate: boolean | JevLocateOptions | undefined,
): Required<JevLocateOptions> | undefined {
  if (locate === undefined || locate === false) {
    return undefined;
  }
  const options = locate === true ? {} : locate;
  return {
    chunkLines: options.chunkLines ?? DEFAULT_LOCATE_CHUNK_LINES,
    lineMin: options.lineMin ?? DEFAULT_LOCATE_LINE_MIN,
    maxLines: options.maxLines ?? DEFAULT_LOCATE_MAX_LINES,
    maxChunks: options.maxChunks ?? DEFAULT_LOCATE_MAX_CHUNKS,
  };
}

export function toQuestion(question: JevRuleQuestion): JevQuestion {
  switch (question.type) {
    case "noul":
      return question.criteria === undefined
        ? { type: "noul", instructions: question.instructions }
        : {
            type: "noul",
            instructions: question.instructions,
            criteria: question.criteria,
          };
    case "choice":
      return {
        type: "choice",
        instructions: question.instructions,
        criteria: question.criteria,
      };
    case "score":
      return {
        type: "score",
        instructions: question.instructions,
        criteria: question.criteria,
      };
  }
}

function formatNumber(value: number): string {
  return String(Number(value.toFixed(3)));
}

function roundScore(noul: number, probability: number): number {
  return Number((noul * probability).toFixed(3));
}

function choiceProbability(answer: JevChoiceAnswer): number {
  const probability = answer.probabilities?.[answer.choice];
  return typeof probability === "number" && Number.isFinite(probability)
    ? probability
    : answer.confidence;
}

function answerMessage(
  id: string,
  question: JevRuleQuestion,
  answer: JevAnswer,
): string {
  if (question.report.message !== undefined) {
    return question.report.message;
  }
  if (answer.type === "noul") {
    return `Jev "${id}": noul=${formatNumber(answer.noul)}`;
  }
  if (answer.type === "choice") {
    return `Jev "${id}": ${answer.choice} (confidence ${formatNumber(answer.confidence)})`;
  }
  return `Jev "${id}": score=${formatNumber(answer.score)} (confidence ${formatNumber(answer.confidence)})`;
}

export function documentRange(document: Document): DiagnosticRange {
  let end = document.text.length;
  while (
    end > 0 &&
    (document.text[end - 1] === "\n" || document.text[end - 1] === "\r")
  ) {
    end -= 1;
  }
  const position = positionAt(document, end);
  return {
    line: 1,
    column: 1,
    endLine: position.line,
    endColumn: position.column,
  };
}

function severityFor(report: JevReportSpec): Severity {
  return report.severity ?? DEFAULT_SEVERITY;
}

function legacyFinding(
  document: Document,
  model: string,
  id: string,
  question: JevRuleQuestion,
  answer: JevAnswer,
): Diagnostic {
  return {
    ruleId: id,
    severity: severityFor(question.report),
    message: answerMessage(id, question, answer),
    path: document.path,
    range: documentRange(document),
    data: { questionId: id, answer, model },
  };
}

function documentFinding(
  document: Document,
  model: string,
  id: string,
  question: JevRuleQuestion,
  noul: number,
): Diagnostic {
  return {
    ruleId: id,
    severity: severityFor(question.report),
    message:
      question.report.message ??
      `Jev "${id}": noul=${formatNumber(noul)}`,
    path: document.path,
    range: documentRange(document),
    score: roundScore(noul, 1),
    data: {
      questionId: id,
      stage: "document",
      noul,
      model,
    } satisfies JevFindingData,
  };
}

function chunkFinding(
  document: Document,
  model: string,
  id: string,
  question: JevRuleQuestion,
  noul: number,
  chunk: JevChunk,
  chunkKey: string,
  chunkProbability: number,
  chunkConfidence: number | undefined,
): Diagnostic {
  const data: JevFindingData = {
    questionId: id,
    stage: "chunk",
    noul,
    chunk: {
      key: chunkKey,
      lines: [chunk.startLine, chunk.endLine],
      probability: chunkProbability,
    },
    model,
  };
  if (chunkConfidence !== undefined) {
    data.confidence = chunkConfidence;
  }
  return {
    ruleId: id,
    severity: severityFor(question.report),
    message:
      question.report.message ??
      `Jev "${id}": noul=${formatNumber(noul)}, lines ${chunk.startLine}-${chunk.endLine} (p=${formatNumber(chunkProbability)})`,
    path: document.path,
    range: lineRange(document, chunk.startLine, chunk.endLine),
    score: roundScore(noul, chunkProbability),
    data,
  };
}

function lineProbabilities(
  answer: JevChoiceAnswer,
  chunk: JevChunk,
): Array<[number, number]> {
  const entries: Array<[number, number]> = [];
  for (let line = chunk.startLine; line <= chunk.endLine; line += 1) {
    const key = String(line);
    const probability =
      answer.probabilities?.[key] ??
      (answer.choice === key ? answer.confidence : undefined);
    if (typeof probability === "number" && Number.isFinite(probability)) {
      entries.push([line, probability]);
    }
  }
  return entries;
}

function lineFinding(
  document: Document,
  model: string,
  hit: RefineHit,
  answer: JevChoiceAnswer,
  source: RefineSource,
  line: number,
  probability: number,
): Diagnostic {
  return {
    ruleId: hit.id,
    severity: severityFor(hit.question.report),
    message:
      hit.question.report.message ??
      `Jev "${hit.id}": noul=${formatNumber(hit.noul)}, line ${line} (p=${formatNumber(probability)})`,
    path: document.path,
    range: lineRange(document, line),
    score: roundScore(hit.noul, probability),
    data: {
      questionId: hit.id,
      stage: "line",
      noul: hit.noul,
      chunk: {
        key: source.chunkKey,
        lines: [source.chunk.startLine, source.chunk.endLine],
        probability: source.chunkProbability,
      },
      lineProbability: probability,
      confidence: answer.confidence,
      model,
    } satisfies JevFindingData,
  };
}

interface DecideInput {
  stage: "classify" | "refine";
  client: JevClient;
  rulesetHash: string;
  variant: "localized" | "plain";
  state: JevState;
  questions: Record<string, JevQuestion>;
  cache?: JevFunnelCache;
}

async function decide(input: DecideInput): Promise<JevResponse> {
  const key = input.cache
    ? jevRequestKey({
        rulesetHash: input.rulesetHash,
        stage: input.stage,
        variant: input.variant,
        state: input.state,
        questions: input.questions,
      })
    : undefined;

  if (key !== undefined && input.cache) {
    const cached = await input.cache.get(key);
    if (cached) {
      return cached;
    }
  }

  const response = await input.client.decide({
    state: input.state,
    questions: input.questions,
  });

  if (key !== undefined && input.cache) {
    await input.cache.set(key, response);
  }
  return response;
}

function fullState(document: Document): JevState {
  return {
    path: document.path,
    language: document.language,
    text: document.text,
  };
}

function partState(document: Document, part: JevPart): JevState {
  return {
    path: document.path,
    language: document.language,
    startLine: part.startLine,
    endLine: part.endLine,
    text: renderLines(document, part.startLine, part.endLine),
  };
}

function chunkState(document: Document, chunk: JevChunk): JevState {
  return {
    path: document.path,
    language: document.language,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    text: renderNumberedLines(document, chunk.startLine, chunk.endLine),
  };
}

function payloadChars(
  model: string,
  state: JevState,
  questions: Record<string, JevQuestion>,
): number {
  return JSON.stringify({ model, state, questions }).length;
}

function fits(
  model: string,
  budget: JevBudget,
  state: JevState,
  questions: Record<string, JevQuestion>,
): boolean {
  return fitsBudget(payloadChars(model, state, questions), budget);
}

function chunkQuestion(
  question: JevRuleQuestion,
  document: Document,
  chunks: readonly JevChunk[],
): JevQuestion {
  return {
    type: "choice",
    instructions: `The file was flagged for: ${question.instructions}. Which section exhibits the issue?`,
    criteria: renderChunkCriteria(document, chunks),
  };
}

function lineQuestion(
  question: JevRuleQuestion,
  document: Document,
  chunk: JevChunk,
): JevQuestion {
  return {
    type: "choice",
    instructions: `The file was flagged for: ${question.instructions}. Which line in the section exhibits the issue?`,
    criteria: renderLineCriteria(document, chunk),
  };
}

function buildGroups(
  document: Document,
  entries: ReadonlyArray<[string, JevRuleQuestion]>,
  plain: Record<string, JevQuestion>,
  plans: ReadonlyMap<string, JevChunkPlan>,
  filter?: (chunk: JevChunk) => boolean,
): Array<QuestionGroup<JevQuestion>> {
  const groups: Array<QuestionGroup<JevQuestion>> = [];
  for (const [id, question] of entries) {
    const questions: Record<string, JevQuestion> = {};
    const base = plain[id];
    if (base !== undefined) {
      questions[id] = base;
    }
    const plan = plans.get(id);
    if (plan !== undefined && !plan.singleChunk) {
      const chunks = filter ? plan.chunks.filter(filter) : plan.chunks;
      if (chunks.length > 0) {
        questions[`${id}#chunk`] = chunkQuestion(question, document, chunks);
      }
    }
    groups.push({ id, questions });
  }
  return groups;
}

function flattenGroups(
  groups: ReadonlyArray<QuestionGroup<JevQuestion>>,
): Record<string, JevQuestion> {
  const questions: Record<string, JevQuestion> = {};
  for (const group of groups) {
    Object.assign(questions, group.questions);
  }
  return questions;
}

function buildPlans(
  document: Document,
  entries: ReadonlyArray<[string, JevRuleQuestion]>,
): Map<string, JevChunkPlan> {
  const plans = new Map<string, JevChunkPlan>();
  for (const [id, question] of entries) {
    if (question.type !== "noul") {
      continue;
    }
    const locate = resolveLocate(question.locate);
    if (!locate) {
      continue;
    }
    const chunks = chunkDocument(document, {
      chunkLines: locate.chunkLines,
      maxChunks: locate.maxChunks,
    });
    plans.set(id, { locate, chunks, singleChunk: chunks.length === 1 });
  }
  return plans;
}

function growPlans(document: Document, plans: Map<string, JevChunkPlan>): boolean {
  const total = lineCount(document);
  let grew = false;
  for (const plan of plans.values()) {
    if (plan.singleChunk) {
      continue;
    }
    const next = Math.min(total, plan.locate.chunkLines * 2);
    if (next <= plan.locate.chunkLines) {
      continue;
    }
    plan.locate.chunkLines = next;
    plan.chunks = chunkDocument(document, {
      chunkLines: next,
      maxChunks: plan.locate.maxChunks,
    });
    plan.singleChunk = plan.chunks.length === 1;
    grew = true;
  }
  return grew;
}

function planClassify(input: {
  document: Document;
  entries: ReadonlyArray<[string, JevRuleQuestion]>;
  plain: Record<string, JevQuestion>;
  model: string;
  budget: JevBudget;
}): ClassifyPlanning {
  const { document, entries, plain, model, budget } = input;
  const limit = requestBudgetChars(budget);
  const plans = buildPlans(document, entries);
  const originals = new Map(
    [...plans].map(([id, plan]) => [
      id,
      {
        chunkLines: plan.locate.chunkLines,
        chunks: plan.chunks,
        singleChunk: plan.singleChunk,
      },
    ]),
  );
  const state = fullState(document);

  let groups = buildGroups(document, entries, plain, plans);
  if (fits(model, budget, state, flattenGroups(groups))) {
    return {
      requests: [{ state, questions: flattenGroups(groups) }],
      plans,
      localized: true,
    };
  }

  for (let attempt = 0; attempt < CHUNK_GROW_ATTEMPTS; attempt += 1) {
    if (!growPlans(document, plans)) {
      break;
    }
    groups = buildGroups(document, entries, plain, plans);
    if (fits(model, budget, state, flattenGroups(groups))) {
      return {
        requests: [{ state, questions: flattenGroups(groups) }],
        plans,
        localized: true,
      };
    }
  }

  const batches = batchQuestionGroups(groups, (questions) =>
    fits(model, budget, state, questions),
  );
  if (batches) {
    return {
      requests: batches.map((questions) => ({ state, questions })),
      plans,
      localized: true,
    };
  }

  for (const [id, plan] of plans) {
    const original = originals.get(id);
    if (original === undefined) {
      continue;
    }
    plan.locate.chunkLines = original.chunkLines;
    plan.chunks = original.chunks;
    plan.singleChunk = original.singleChunk;
  }
  groups = buildGroups(document, entries, plain, plans);

  const maxGroupChars = Math.max(
    0,
    ...groups.map((group) => JSON.stringify(group.questions).length),
  );
  const partBudget = limit - maxGroupChars - PART_OVERHEAD_CHARS;
  if (partBudget >= MIN_PART_CHARS) {
    const { parts, oversized } = partitionParts(document, partBudget);
    if (!oversized && parts.length > 1) {
      const requests: ClassifyRequest[] = [];
      for (const part of parts) {
        const stateForPart = partState(document, part);
        const partGroups = buildGroups(
          document,
          entries,
          plain,
          plans,
          (chunk) =>
            chunk.endLine >= part.startLine && chunk.startLine <= part.endLine,
        );
        const partBatches = batchQuestionGroups(partGroups, (questions) =>
          fits(model, budget, stateForPart, questions),
        );
        if (!partBatches) {
          requests.length = 0;
          break;
        }
        for (const questions of partBatches) {
          requests.push({ state: stateForPart, questions, part });
        }
      }
      if (requests.length > 0) {
        return { requests, plans, localized: true };
      }
    }
  }

  return {
    requests: [{ state, questions: plain }],
    plans,
    localized: false,
  };
}

function mergeBuckets(
  responses: ReadonlyArray<{ response: JevResponse; part?: JevPart }>,
): Map<string, AnswerBucket> {
  const buckets = new Map<string, AnswerBucket>();
  for (const { response, part } of responses) {
    const key = part === undefined ? "" : String(part.index);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { answers: {}, model: response.model };
      buckets.set(key, bucket);
    }
    Object.assign(bucket.answers, response.answers);
  }
  return buckets;
}

function preferAnswer(
  question: JevRuleQuestion,
  candidate: JevAnswer,
  current: JevAnswer,
): boolean {
  if (question.type === "noul") {
    return (
      candidate.type === "noul" &&
      current.type === "noul" &&
      candidate.noul > current.noul
    );
  }
  if (question.type === "choice") {
    return (
      candidate.type === "choice" &&
      current.type === "choice" &&
      candidate.confidence > current.confidence
    );
  }
  return (
    candidate.type === "score" &&
    current.type === "score" &&
    candidate.score > current.score
  );
}

function chooseAnswer(
  question: JevRuleQuestion,
  id: string,
  buckets: ReadonlyMap<string, AnswerBucket>,
): ChosenAnswer | undefined {
  let chosen: ChosenAnswer | undefined;
  for (const bucket of buckets.values()) {
    const answer = bucket.answers[id];
    if (answer === undefined) {
      continue;
    }
    if (chosen === undefined || preferAnswer(question, answer, chosen.answer)) {
      chosen = { answer, model: bucket.model, bucket };
    }
  }
  return chosen;
}

function linesAbove(
  probabilities: ReadonlyArray<[number, number]>,
  locate: Required<JevLocateOptions>,
): Array<[number, number]> {
  return probabilities
    .filter(([, probability]) => probability >= locate.lineMin)
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, locate.maxLines)
    .toSorted((a, b) => a[0] - b[0]);
}

function argmaxLine(
  probabilities: ReadonlyArray<[number, number]>,
): [number, number] | undefined {
  return probabilities.reduce<[number, number] | undefined>(
    (best, entry) => (best === undefined || entry[1] > best[1] ? entry : best),
    undefined,
  );
}

function mergeLineFindings(findings: readonly Diagnostic[]): Diagnostic[] {
  const best = new Map<string, Diagnostic>();
  for (const finding of findings) {
    const key = `${finding.ruleId}\u0000${finding.range.line}`;
    const existing = best.get(key);
    if (existing === undefined || (finding.score ?? 0) > (existing.score ?? 0)) {
      best.set(key, finding);
    }
  }
  return [...best.values()];
}

interface RefineInput {
  document: Document;
  client: JevClient;
  rulesetHash: string;
  budget: JevBudget;
  hit: RefineHit;
  cache?: JevFunnelCache;
}

async function refineHit(input: RefineInput): Promise<Diagnostic[]> {
  const { document, client, rulesetHash, budget, hit, cache } = input;
  const lineId = `${hit.id}#line`;
  const question = lineQuestion(hit.question, document, hit.chunk);
  const state = chunkState(document, hit.chunk);
  const primary: RefineSource = {
    chunk: hit.chunk,
    chunkKey: hit.chunkKey,
    chunkProbability: hit.chunkProbability,
    chunkConfidence: hit.chunkConfidence,
  };

  if (!fits(client.model, budget, state, { [lineId]: question })) {
    return [
      chunkFinding(
        document,
        hit.model,
        hit.id,
        hit.question,
        hit.noul,
        hit.chunk,
        hit.chunkKey,
        hit.chunkProbability,
        hit.chunkConfidence,
      ),
    ];
  }

  const response = await decide({
    stage: "refine",
    client,
    rulesetHash,
    variant: "localized",
    state,
    questions: { [lineId]: question },
    cache,
  });
  const answer = response.answers[lineId];
  if (answer === undefined) {
    throw new JevError(`Jev response is missing an answer for "${lineId}"`);
  }
  if (answer.type !== "choice") {
    throw answerTypeError(lineId, "choice", answer.type);
  }

  const probabilities = lineProbabilities(answer, hit.chunk);
  const above = linesAbove(probabilities, hit.locate);
  if (above.length > 0) {
    return above.map(([line, probability]) =>
      lineFinding(document, response.model, hit, answer, primary, line, probability),
    );
  }

  if (hit.adjacent.length > 0) {
    const adjacentSources = await Promise.all(
      hit.adjacent.map(async (chunk) => {
        const adjacentState = chunkState(document, chunk);
        const adjacentQuestion = lineQuestion(hit.question, document, chunk);
        if (!fits(client.model, budget, adjacentState, { [lineId]: adjacentQuestion })) {
          return undefined;
        }
        const adjacentResponse = await decide({
          stage: "refine",
          client,
          rulesetHash,
          variant: "localized",
          state: adjacentState,
          questions: { [lineId]: adjacentQuestion },
          cache,
        });
        return { chunk, response: adjacentResponse };
      }),
    );

    const expanded: Array<{
      source: RefineSource;
      answer: JevChoiceAnswer;
      model: string;
      line: number;
      probability: number;
    }> = [];
    for (const adjacent of adjacentSources) {
      if (adjacent === undefined) {
        continue;
      }
      const adjacentAnswer = adjacent.response.answers[lineId];
      if (adjacentAnswer === undefined) {
        continue;
      }
      if (adjacentAnswer.type !== "choice") {
        throw answerTypeError(lineId, "choice", adjacentAnswer.type);
      }
      const source: RefineSource = {
        chunk: adjacent.chunk,
        chunkKey: String(adjacent.chunk.index),
        chunkProbability: 1,
      };
      for (const [line, probability] of lineProbabilities(
        adjacentAnswer,
        adjacent.chunk,
      )) {
        if (probability >= hit.locate.lineMin) {
          expanded.push({
            source,
            answer: adjacentAnswer,
            model: adjacent.response.model,
            line,
            probability,
          });
        }
      }
    }

    const capped = expanded
      .toSorted((a, b) => b.probability - a.probability)
      .slice(0, hit.locate.maxLines)
      .toSorted((a, b) => a.line - b.line);
    if (capped.length > 0) {
      return capped.map((entry) =>
        lineFinding(
          document,
          entry.model,
          hit,
          entry.answer,
          entry.source,
          entry.line,
          entry.probability,
        ),
      );
    }
  }

  const best = argmaxLine(probabilities);
  if (best === undefined) {
    return [];
  }
  return [
    lineFinding(document, response.model, hit, answer, primary, best[0], best[1]),
  ];
}

export async function runJevFunnel(
  input: JevFunnelInput,
): Promise<Diagnostic[]> {
  const { document, options, client, cache, onNotice } = input;
  const questions = options.questions;
  if (!questions) {
    return [];
  }
  const entries = Object.entries(questions);
  if (entries.length === 0) {
    return [];
  }

  const model = client.model;
  const rulesetHash = hashRuleset(model, questions);
  const budget: JevBudget = {
    contextTokens: options.contextTokens ?? DEFAULT_CONTEXT_TOKENS,
    reservedOutputTokens:
      options.reservedOutputTokens ?? DEFAULT_RESERVED_OUTPUT_TOKENS,
  };

  const plain: Record<string, JevQuestion> = {};
  for (const [id, question] of entries) {
    plain[id] = toQuestion(question);
  }

  const planning = planClassify({ document, entries, plain, model, budget });
  let localized = planning.localized;
  const { plans } = planning;
  if (!localized) {
    onNotice?.(localizationNotice());
  }

  let responses: Array<{ response: JevResponse; part?: JevPart }>;
  try {
    responses = await Promise.all(
      planning.requests.map(async (request) => ({
        response: await decide({
          stage: "classify",
          client,
          rulesetHash,
          variant: localized ? "localized" : "plain",
          state: request.state,
          questions: request.questions,
          cache,
        }),
        part: request.part,
      })),
    );
  } catch (error) {
    if (!localized || !isJevTokenLimitError(error)) {
      throw error;
    }
    localized = false;
    onNotice?.(localizationNotice());
    const response = await decide({
      stage: "classify",
      client,
      rulesetHash,
      variant: "plain",
      state: fullState(document),
      questions: plain,
      cache,
    });
    responses = [{ response }];
  }

  const buckets = mergeBuckets(responses);
  const diagnostics: Diagnostic[] = [];
  const refineHits: RefineHit[] = [];

  for (const [id, question] of entries) {
    const chosen = chooseAnswer(question, id, buckets);
    if (chosen === undefined) {
      throw new JevError(`Jev response is missing an answer for "${id}"`);
    }
    if (!shouldReport(id, question, chosen.answer)) {
      continue;
    }

    if (question.type !== "noul") {
      diagnostics.push(
        legacyFinding(document, chosen.model, id, question, chosen.answer),
      );
      continue;
    }
    if (chosen.answer.type !== "noul") {
      throw answerTypeError(id, "noul", chosen.answer.type);
    }

    const plan = localized ? plans.get(id) : undefined;
    if (!plan) {
      diagnostics.push(
        documentFinding(
          document,
          chosen.model,
          id,
          question,
          chosen.answer.noul,
        ),
      );
      continue;
    }

    const noul = chosen.answer.noul;
    let chunk: JevChunk;
    let chunkKey: string;
    let chunkProbability: number;
    let chunkConfidence: number | undefined;

    if (plan.singleChunk) {
      const firstChunk = plan.chunks[0];
      if (firstChunk === undefined) {
        throw new JevError(`Jev chunk plan for "${id}" is empty`);
      }
      chunk = firstChunk;
      chunkKey = String(chunk.index);
      chunkProbability = 1;
    } else {
      const chunkId = `${id}#chunk`;
      const chunkAnswer = chosen.bucket.answers[chunkId];
      if (chunkAnswer === undefined) {
        throw new JevError(`Jev response is missing an answer for "${chunkId}"`);
      }
      if (chunkAnswer.type !== "choice") {
        throw answerTypeError(chunkId, "choice", chunkAnswer.type);
      }
      const found = plan.chunks.find(
        (candidate) => String(candidate.index) === chunkAnswer.choice,
      );
      if (!found) {
        continue;
      }
      chunk = found;
      chunkKey = chunkAnswer.choice;
      chunkProbability = choiceProbability(chunkAnswer);
      chunkConfidence = chunkAnswer.confidence;
    }

    if (chunk.startLine === chunk.endLine) {
      diagnostics.push(
        chunkFinding(
          document,
          chosen.model,
          id,
          question,
          noul,
          chunk,
          chunkKey,
          chunkProbability,
          chunkConfidence,
        ),
      );
      continue;
    }

    const position = plan.chunks.findIndex(
      (candidate) => candidate.index === chunk.index,
    );
    const adjacent: JevChunk[] = [];
    if (position > 0) {
      const previous = plan.chunks[position - 1];
      if (previous !== undefined) {
        adjacent.push(previous);
      }
    }
    const next = plan.chunks[position + 1];
    if (next !== undefined) {
      adjacent.push(next);
    }

    refineHits.push({
      id,
      question,
      noul,
      locate: plan.locate,
      model: chosen.model,
      chunk,
      chunkKey,
      chunkProbability,
      chunkConfidence,
      adjacent,
    });
  }

  if (refineHits.length === 0) {
    return diagnostics;
  }

  const lineFindings = await Promise.all(
    refineHits.map((hit) =>
      refineHit({ document, client, rulesetHash, budget, hit, cache }),
    ),
  );

  return [...diagnostics, ...mergeLineFindings(lineFindings.flat())];
}

export function isJevResponse(value: unknown): value is JevResponse {
  return (
    isRecord(value) && isRecord(value.answers) && isRecord(value.usage)
  );
}
