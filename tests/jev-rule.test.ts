import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  JevError,
  resetJevState,
  type JevClient,
  type JevDecideRequest,
  type JevResponse,
} from "../src/lib/ai/jev.js";
import { ConfigError } from "../src/lib/errors.js";
import { createDocument } from "../src/lib/lint/documents.js";
import {
  jevRule,
  parseJevRuleOptions,
  type JevRuleOptions,
} from "../src/lib/lint/rules/jev.js";
import {
  runJevFunnel,
  type JevFunnelCache,
} from "../src/lib/lint/rules/jev-funnel.js";
import type { Document } from "../src/lib/lint/types.js";
import { defined } from "./helpers.js";

const MODEL = "typesafe/jev-1.13";
const USAGE = { input_tokens: 10, output_tokens: 2 };

function parse(options: unknown): JevRuleOptions {
  return parseJevRuleOptions(options);
}

function response(answers: JevResponse["answers"], model = MODEL): JevResponse {
  return { model, answers, usage: USAGE };
}

interface FakeClient extends JevClient {
  calls: JevDecideRequest[];
}

function fakeClient(responses: readonly JevResponse[]): FakeClient {
  const calls: JevDecideRequest[] = [];
  let index = 0;
  return {
    model: MODEL,
    calls,
    async decide(request) {
      calls.push(request);
      const queued = responses[index];
      index += 1;
      if (!queued) {
        throw new Error(`unexpected decide call ${index}`);
      }
      return queued;
    },
  };
}

function documentOf(lines: number, filePath = "src/a.ts"): Document {
  const text = `${Array.from(
    { length: lines },
    (_, index) => `line ${index + 1}`,
  ).join("\n")}\n`;
  return createDocument(filePath, text);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetJevState();
});

describe("parseJevRuleOptions", () => {
  it("accepts empty options and options without questions", () => {
    expect(parse({})).toEqual({});
    expect(parse({ model: "typesafe/jev-1.13" })).toEqual({
      model: "typesafe/jev-1.13",
    });
  });

  it("accepts a noul question without a report", () => {
    const parsed = parse({
      questions: { urgent: { type: "noul", instructions: "Urgent?" } },
    });
    expect(Object.keys(parsed.questions ?? {})).toEqual(["urgent"]);
    expect(parsed.questions?.urgent?.report).toEqual({});
  });

  it("rejects malformed options", () => {
    expect(() => parse({ questions: {} })).toThrowError(/at least one question/);
    expect(() => parse({ questions: {}, extra: true })).toThrowError(
      /unknown option "extra"/,
    );
    expect(() => parse({ questions: "nope" })).toThrowError(
      /"questions" must be an object/,
    );
    expect(() =>
      parse({ questions: { a: { type: "noul", instructions: "" } } }),
    ).toThrowError(/"instructions"/);
    expect(() =>
      parse({ questions: { a: { type: "todo", instructions: "x" } } }),
    ).toThrowError(/"type" must be one of/);
  });

  it("requires a trigger on the report", () => {
    expect(() =>
      parse({
        questions: {
          a: { type: "score", instructions: "x", criteria: ["a", "b"] },
        },
      }),
    ).toThrowError(/report "min" or "max"/);
    expect(() =>
      parse({
        questions: {
          a: { type: "choice", instructions: "x", criteria: { a: "A" } },
        },
      }),
    ).toThrowError(/report "is" or "not"/);
  });

  it("rejects report options that do not fit the question type", () => {
    expect(() =>
      parse({
        questions: {
          a: { type: "noul", instructions: "x", report: { min: 2 } },
        },
      }),
    ).toThrowError(/between 0 and 1/);
    expect(() =>
      parse({
        questions: {
          a: {
            type: "choice",
            instructions: "x",
            criteria: { a: "A" },
            report: { min: 1, is: ["a"] },
          },
        },
      }),
    ).toThrowError(/only apply to noul and score/);
    expect(() =>
      parse({
        questions: {
          a: { type: "noul", instructions: "x", report: { is: ["a"] } },
        },
      }),
    ).toThrowError(/only apply to choice/);
  });

  it("validates criteria shapes", () => {
    expect(() =>
      parse({
        questions: {
          a: { type: "noul", instructions: "x", criteria: { true: "yes" } },
        },
      }),
    ).toThrowError(/noul criteria/);
    expect(() =>
      parse({
        questions: {
          a: { type: "choice", instructions: "x", criteria: {} },
        },
      }),
    ).toThrowError(/choice criteria/);
    expect(() =>
      parse({
        questions: {
          a: { type: "score", instructions: "x", criteria: ["only one"] },
        },
      }),
    ).toThrowError(/at least two strings/);
  });

  it("parses locate options", () => {
    const parsed = parse({
      questions: {
        a: { type: "noul", instructions: "A?", locate: true },
        b: {
          type: "noul",
          instructions: "B?",
          locate: { chunkLines: 20, lineMin: 0.5, maxLines: 5, maxChunks: 7 },
        },
      },
    });
    const locate = (id: string): unknown =>
      (parsed.questions?.[id] as { locate?: unknown } | undefined)?.locate;
    expect(locate("a")).toBe(true);
    expect(locate("b")).toEqual({
      chunkLines: 20,
      lineMin: 0.5,
      maxLines: 5,
      maxChunks: 7,
    });
  });

  it("validates context token options", () => {
    expect(parse({ contextTokens: 4_096, reservedOutputTokens: 1_024 })).toEqual({
      contextTokens: 4_096,
      reservedOutputTokens: 1_024,
    });
    expect(() => parse({ contextTokens: 0 })).toThrowError(/contextTokens/);
    expect(() => parse({ reservedOutputTokens: 1.5 })).toThrowError(
      /reservedOutputTokens/,
    );
    expect(() =>
      parse({ contextTokens: 4_096, reservedOutputTokens: 4_096 }),
    ).toThrowError(/smaller than "contextTokens"/);
  });

  it("rejects invalid locate options", () => {
    expect(() =>
      parse({ questions: { a: { type: "noul", instructions: "x", locate: 1 } } }),
    ).toThrowError(/"locate" must be a boolean or an options object/);
    expect(() =>
      parse({
        questions: {
          a: { type: "noul", instructions: "x", locate: { nope: 1 } },
        },
      }),
    ).toThrowError(/unknown locate option "nope"/);
    expect(() =>
      parse({
        questions: {
          a: { type: "noul", instructions: "x", locate: { chunkLines: 0 } },
        },
      }),
    ).toThrowError(/chunkLines/);
    expect(() =>
      parse({
        questions: {
          a: { type: "noul", instructions: "x", locate: { lineMin: 2 } },
        },
      }),
    ).toThrowError(/lineMin/);
    expect(() =>
      parse({
        questions: {
          a: { type: "noul", instructions: "x", locate: { maxLines: -1 } },
        },
      }),
    ).toThrowError(/maxLines/);
    expect(() =>
      parse({
        questions: {
          a: { type: "noul", instructions: "x", locate: { maxChunks: 0 } },
        },
      }),
    ).toThrowError(/maxChunks/);
    expect(() =>
      parse({
        questions: {
          a: {
            type: "choice",
            instructions: "x",
            criteria: { a: "A" },
            report: { is: ["a"] },
            locate: true,
          },
        },
      }),
    ).toThrowError(/"locate" only applies to noul questions/);
  });

  it("validates maxFileBytes and cache", () => {
    expect(() => parse({ maxFileBytes: 0 })).toThrowError(/maxFileBytes/);
    expect(() => parse({ maxFileBytes: 1.5 })).toThrowError(/maxFileBytes/);
    expect(() => parse({ cache: "yes" })).toThrowError(/"cache" must be a boolean/);
    expect(parse({ cache: true, maxFileBytes: 1024 })).toEqual({
      cache: true,
      maxFileBytes: 1024,
    });
  });
});

describe("runJevFunnel", () => {
  it("batches authored and #chunk questions into one request", async () => {
    const options = parse({
      questions: {
        a: { type: "noul", instructions: "A?", locate: true },
        b: { type: "noul", instructions: "B?", locate: { chunkLines: 10 } },
        c: { type: "noul", instructions: "C?" },
      },
    });
    const client = fakeClient([
      response({
        a: { type: "noul", noul: 0.9 },
        "a#chunk": {
          type: "choice",
          choice: "1",
          confidence: 0.8,
          probabilities: { "1": 0.8, "2": 0.2 },
        },
        b: { type: "noul", noul: 0.3 },
        "b#chunk": { type: "choice", choice: "2", confidence: 0.7 },
        c: { type: "noul", noul: 0.85 },
      }),
      response({
        "a#line": {
          type: "choice",
          choice: "3",
          confidence: 0.6,
          probabilities: { "1": 0.1, "2": 0.15, "3": 0.6 },
        },
      }),
    ]);

    const diagnostics = await runJevFunnel({
      document: documentOf(30),
      options,
      client,
    });

    expect(client.calls).toHaveLength(2);
    expect(Object.keys(defined(client.calls[0]).questions)).toEqual([
      "a",
      "a#chunk",
      "b",
      "b#chunk",
      "c",
    ]);
    expect(defined(client.calls[0]).questions["a#chunk"]).toMatchObject({
      type: "choice",
      instructions:
        "The file was flagged for: A?. Which section exhibits the issue?",
    });
    expect(Object.keys(defined(client.calls[1]).questions)).toEqual(["a#line"]);
    expect(defined(client.calls[1]).questions["a#line"]).toMatchObject({
      instructions:
        "The file was flagged for: A?. Which line in the section exhibits the issue?",
    });
    expect(defined(client.calls[1]).state).toMatchObject({ path: "src/a.ts" });

    const chunkQuestion = defined(client.calls[0]).questions["a#chunk"] as {
      criteria: Record<string, string>;
    };
    expect(chunkQuestion.criteria["1"]).toBe("lines 1-15: line 1");
    const lineQuestion = defined(client.calls[1]).questions["a#line"] as {
      criteria: Record<string, string>;
    };
    expect(lineQuestion.criteria["3"]).toBe("line 3");

    expect(diagnostics.map((diagnostic) => diagnostic.ruleId)).toEqual([
      "c",
      "a",
    ]);
    expect(diagnostics[1]).toMatchObject({
      range: { line: 3, column: 1, endLine: 3, endColumn: 7 },
      score: 0.54,
    });
  });

  it("issues one request when no rule crosses its threshold", async () => {
    const options = parse({
      questions: { a: { type: "noul", instructions: "A?", locate: true } },
    });
    const client = fakeClient([
      response({
        a: { type: "noul", noul: 0.1 },
        "a#chunk": { type: "choice", choice: "1", confidence: 0.9 },
      }),
    ]);

    const diagnostics = await runJevFunnel({
      document: documentOf(30),
      options,
      client,
    });

    expect(diagnostics).toEqual([]);
    expect(client.calls).toHaveLength(1);
  });

  it("reports a chunk-level diagnostic when the chosen chunk is one line", async () => {
    const options = parse({
      questions: {
        a: { type: "noul", instructions: "A?", locate: { chunkLines: 1 } },
      },
    });
    const client = fakeClient([
      response({
        a: { type: "noul", noul: 0.9 },
        "a#chunk": {
          type: "choice",
          choice: "2",
          confidence: 0.9,
          probabilities: { "1": 0.1, "2": 0.9 },
        },
      }),
    ]);

    const diagnostics = await runJevFunnel({
      document: documentOf(6),
      options,
      client,
    });

    expect(client.calls).toHaveLength(1);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      ruleId: "a",
      range: { line: 2, column: 1, endLine: 2, endColumn: 7 },
      score: 0.81,
      data: {
        questionId: "a",
        stage: "chunk",
        noul: 0.9,
        chunk: { key: "2", lines: [2, 2], probability: 0.9 },
        confidence: 0.9,
        model: MODEL,
      },
    });
  });

  it("refines a single-chunk document over the whole file", async () => {
    const options = parse({
      questions: { a: { type: "noul", instructions: "A?", locate: true } },
    });
    const client = fakeClient([
      response({ a: { type: "noul", noul: 0.9 } }),
      response({
        "a#line": {
          type: "choice",
          choice: "2",
          confidence: 0.8,
          probabilities: { "1": 0.1, "2": 0.8, "3": 0.1 },
        },
      }),
    ]);

    const diagnostics = await runJevFunnel({
      document: documentOf(3),
      options,
      client,
    });

    expect(client.calls).toHaveLength(2);
    expect(Object.keys(defined(client.calls[0]).questions)).toEqual(["a"]);
    expect(Object.keys(defined(client.calls[1]).questions)).toEqual(["a#line"]);
    expect(
      Object.keys(
        (defined(client.calls[1]).questions["a#line"] as { criteria: object }).criteria,
      ),
    ).toEqual(["1", "2", "3"]);
    expect(defined(client.calls[1]).state).toMatchObject({
      startLine: 1,
      endLine: 3,
      text: "1 | line 1\n2 | line 2\n3 | line 3",
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      range: { line: 2, column: 1, endLine: 2, endColumn: 7 },
      score: 0.72,
      data: {
        stage: "line",
        chunk: { key: "1", lines: [1, 3], probability: 1 },
        lineProbability: 0.8,
        confidence: 0.8,
      },
    });
  });

  it("reports only a chunk finding for a single-line document", async () => {
    const options = parse({
      questions: { a: { type: "noul", instructions: "A?", locate: true } },
    });
    const client = fakeClient([response({ a: { type: "noul", noul: 0.9 } })]);

    const diagnostics = await runJevFunnel({
      document: documentOf(1),
      options,
      client,
    });

    expect(client.calls).toHaveLength(1);
    expect(Object.keys(defined(client.calls[0]).questions)).toEqual(["a"]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      range: { line: 1, column: 1, endLine: 1, endColumn: 7 },
      score: 0.9,
      data: { stage: "chunk", chunk: { key: "1", probability: 1 } },
    });
  });

  it("applies lineMin and reports the argmax line when nothing clears it", async () => {
    const options = parse({
      questions: {
        a: {
          type: "noul",
          instructions: "A?",
          locate: { chunkLines: 15, lineMin: 0.25 },
        },
      },
    });

    const above = fakeClient([
      response({
        a: { type: "noul", noul: 0.8 },
        "a#chunk": { type: "choice", choice: "1", confidence: 0.9 },
      }),
      response({
        "a#line": {
          type: "choice",
          choice: "1",
          confidence: 0.9,
          probabilities: { "1": 0.9, "2": 0.5, "3": 0.3, "4": 0.1 },
        },
      }),
    ]);
    const selected = await runJevFunnel({
      document: documentOf(30),
      options,
      client: above,
    });
    expect(selected.map((diagnostic) => diagnostic.range.line)).toEqual([
      1, 2, 3,
    ]);

    const below = fakeClient([
      response({
        a: { type: "noul", noul: 0.8 },
        "a#chunk": { type: "choice", choice: "1", confidence: 0.9 },
      }),
      response({
        "a#line": {
          type: "choice",
          choice: "3",
          confidence: 0.2,
          probabilities: { "1": 0.1, "2": 0.2, "3": 0.05 },
        },
      }),
      response({
        "a#line": {
          type: "choice",
          choice: "14",
          confidence: 0.1,
          probabilities: { "14": 0.1 },
        },
      }),
    ]);
    const fallback = await runJevFunnel({
      document: documentOf(30),
      options,
      client: below,
    });
    expect(fallback).toHaveLength(1);
    expect(defined(fallback[0]).range.line).toBe(2);
  });

  it("caps reported lines at maxLines, highest score first", async () => {
    const options = parse({
      questions: {
        a: {
          type: "noul",
          instructions: "A?",
          locate: { chunkLines: 15, lineMin: 0.1, maxLines: 2 },
        },
      },
    });
    const client = fakeClient([
      response({
        a: { type: "noul", noul: 0.8 },
        "a#chunk": { type: "choice", choice: "1", confidence: 0.9 },
      }),
      response({
        "a#line": {
          type: "choice",
          choice: "1",
          confidence: 0.9,
          probabilities: { "1": 0.7, "2": 0.9, "3": 0.8 },
        },
      }),
    ]);

    const diagnostics = await runJevFunnel({
      document: documentOf(30),
      options,
      client,
    });

    expect(
      diagnostics.map((diagnostic) => [diagnostic.range.line, diagnostic.score]),
    ).toEqual([
      [2, 0.72],
      [3, 0.64],
    ]);
  });

  it("scores findings as noul times probability and carries the data", async () => {
    const options = parse({
      questions: { a: { type: "noul", instructions: "A?", locate: true } },
    });
    const client = fakeClient([
      response({
        a: { type: "noul", noul: 0.8 },
        "a#chunk": {
          type: "choice",
          choice: "1",
          confidence: 0.7,
          probabilities: { "1": 0.6, "2": 0.4 },
        },
      }),
      response({
        "a#line": {
          type: "choice",
          choice: "2",
          confidence: 0.7,
          probabilities: { "1": 0.1, "2": 0.5 },
        },
      }),
    ]);

    const [diagnostic] = await runJevFunnel({
      document: documentOf(30),
      options,
      client,
    });

    expect(diagnostic).toMatchObject({
      ruleId: "a",
      severity: "warning",
      path: "src/a.ts",
      range: { line: 2, column: 1, endLine: 2, endColumn: 7 },
      score: 0.4,
    });
    expect(defined(diagnostic).message).toBe('Jev "a": noul=0.8, line 2 (p=0.5)');
    expect(defined(diagnostic).data).toEqual({
      questionId: "a",
      stage: "line",
      noul: 0.8,
      chunk: { key: "1", lines: [1, 15], probability: 0.6 },
      lineProbability: 0.5,
      confidence: 0.7,
      model: MODEL,
    });
  });

  it("keeps noul questions without locate at document level", async () => {
    const options = parse({
      questions: {
        a: {
          type: "noul",
          instructions: "A?",
          report: { min: 0.9, message: "urgent", severity: "error" },
        },
      },
    });
    const client = fakeClient([response({ a: { type: "noul", noul: 0.93 } })]);

    const [diagnostic] = await runJevFunnel({
      document: documentOf(2),
      options,
      client,
    });

    expect(diagnostic).toMatchObject({
      ruleId: "a",
      severity: "error",
      message: "urgent",
      score: 0.93,
      range: { line: 1, column: 1, endLine: 2, endColumn: 7 },
    });
    expect(defined(diagnostic).data).toEqual({
      questionId: "a",
      stage: "document",
      noul: 0.93,
      model: MODEL,
    });
  });

  it("uses the default 0.8 noul threshold when no report is given", async () => {
    const options = parse({
      questions: { a: { type: "noul", instructions: "A?" } },
    });

    const miss = fakeClient([response({ a: { type: "noul", noul: 0.79 } })]);
    expect(
      await runJevFunnel({
        document: documentOf(2),
        options,
        client: miss,
      }),
    ).toEqual([]);

    const hit = fakeClient([response({ a: { type: "noul", noul: 0.8 } })]);
    expect(
      await runJevFunnel({
        document: documentOf(2),
        options,
        client: hit,
      }),
    ).toHaveLength(1);
  });

  it("maps choice and score questions to document-level diagnostics", async () => {
    const options = parse({
      questions: {
        team: {
          type: "choice",
          instructions: "Team?",
          criteria: { infra: "Infra", billing: "Billing" },
          report: { is: ["billing"] },
        },
        severity: {
          type: "score",
          instructions: "Severity?",
          criteria: ["Low", "High"],
          report: { min: 1 },
        },
      },
    });
    const client = fakeClient([
      response({
        team: {
          type: "choice",
          choice: "billing",
          confidence: 0.75,
          probabilities: { billing: 0.75 },
        },
        severity: { type: "score", score: 1.2, confidence: 0.9 },
      }),
    ]);

    const diagnostics = await runJevFunnel({
      document: documentOf(2),
      options,
      client,
    });

    expect(diagnostics.map((diagnostic) => diagnostic.ruleId)).toEqual([
      "team",
      "severity",
    ]);
    expect(defined(diagnostics[0]).score).toBeUndefined();
    expect(defined(diagnostics[0]).message).toBe(
      'Jev "team": billing (confidence 0.75)',
    );
  });

  it("drops unknown chunk keys and throws on missing answers", async () => {
    const options = parse({
      questions: { a: { type: "noul", instructions: "A?", locate: true } },
    });

    const unknown = fakeClient([
      response({
        a: { type: "noul", noul: 0.9 },
        "a#chunk": { type: "choice", choice: "99", confidence: 0.9 },
      }),
    ]);
    expect(
      await runJevFunnel({
        document: documentOf(30),
        options,
        client: unknown,
      }),
    ).toEqual([]);

    const missing = fakeClient([response({})]);
    await expect(
      runJevFunnel({
        document: documentOf(30),
        options,
        client: missing,
      }),
    ).rejects.toThrowError(/missing an answer for "a"/);
  });

  it("makes no requests when no questions are configured", async () => {
    const client = fakeClient([]);
    expect(
      await runJevFunnel({
        document: documentOf(2),
        options: parse({}),
        client,
      }),
    ).toEqual([]);
    expect(client.calls).toHaveLength(0);
  });

  it("localizes large files with a compact classify request", async () => {
    const options = parse({
      questions: { a: { type: "noul", instructions: "A?", locate: true } },
    });
    const client = fakeClient([
      response({
        a: { type: "noul", noul: 0.9 },
        "a#chunk": { type: "choice", choice: "1", confidence: 0.9 },
      }),
      response({
        "a#line": {
          type: "choice",
          choice: "1",
          confidence: 0.9,
          probabilities: { "1": 0.9 },
        },
      }),
    ]);
    const notices: string[] = [];

    const diagnostics = await runJevFunnel({
      document: documentOf(6_000),
      options,
      client,
      onNotice: (message) => notices.push(message),
    });

    expect(notices).toEqual([]);
    expect(client.calls).toHaveLength(2);
    const chunkQuestion = defined(client.calls[0]).questions["a#chunk"] as {
      criteria: object;
    };
    expect(Object.keys(chunkQuestion.criteria)).toHaveLength(12);
    expect(defined(diagnostics[0]).range.line).toBe(1);
  });

  it("falls back to document-level findings when no part can fit", async () => {
    const options = parse({
      questions: { a: { type: "noul", instructions: "A?", locate: true } },
    });
    const client = fakeClient([response({ a: { type: "noul", noul: 0.9 } })]);
    const notices: string[] = [];

    const diagnostics = await runJevFunnel({
      document: createDocument("src/a.ts", `${"x".repeat(90_000)}\n`),
      options,
      client,
      onNotice: (message) => notices.push(message),
    });

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.questions).not.toHaveProperty("a#chunk");
    expect(notices[0]).toMatch(/localization skipped/);
    expect(defined(diagnostics[0]).data).toMatchObject({ stage: "document" });
  });

  it("falls back to document-level findings when Jev rejects the request as too large", async () => {
    const options = parse({
      questions: { a: { type: "noul", instructions: "A?", locate: true } },
    });
    const calls: JevDecideRequest[] = [];
    const client: JevClient = {
      model: MODEL,
      async decide(request) {
        calls.push(request);
        if (calls.length === 1) {
          throw new JevError(
            'Jev request failed with status 400: {"detail":{"error_type":"max_tokens_exceeded"}}',
            {
              status: 400,
              detail: '{"detail":{"error_type":"max_tokens_exceeded"}}',
            },
          );
        }
        return response({ a: { type: "noul", noul: 0.9 } });
      },
    };
    const notices: string[] = [];

    const diagnostics = await runJevFunnel({
      document: documentOf(30),
      options,
      client,
      onNotice: (message) => notices.push(message),
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.questions).toHaveProperty("a#chunk");
    expect(calls[1]?.questions).not.toHaveProperty("a#chunk");
    expect(notices[0]).toMatch(/localization skipped/);
    expect(defined(diagnostics[0]).data).toMatchObject({ stage: "document" });
  });

  it("splits oversized files and localizes in the part with the highest noul", async () => {
    const options = parse({
      contextTokens: 2_000,
      reservedOutputTokens: 200,
      questions: { a: { type: "noul", instructions: "A?", locate: true } },
    });
    const calls: JevDecideRequest[] = [];
    const client: JevClient = {
      model: MODEL,
      async decide(request) {
        calls.push(request);
        const state = request.state as { startLine?: number };
        if ("a#chunk" in request.questions) {
          return response({
            a: { type: "noul", noul: state.startLine === 1 ? 0.6 : 0.9 },
            "a#chunk": {
              type: "choice",
              choice: state.startLine === 1 ? "1" : "7",
              confidence: 0.9,
            },
          });
        }
        const line = state.startLine ?? 1;
        return response({
          "a#line": {
            type: "choice",
            choice: String(line),
            confidence: 0.9,
            probabilities: { [String(line)]: 0.9 },
          },
        });
      },
    };

    const diagnostics = await runJevFunnel({
      document: documentOf(800),
      options,
      client,
    });

    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(defined(calls[0]).state).toMatchObject({ startLine: 1 });
    const chunkCriteria = (
      defined(calls[1]).questions["a#chunk"] as {
        criteria: Record<string, string>;
      }
    ).criteria;
    const chunkStart = Number(/lines (\d+)-/.exec(defined(chunkCriteria["7"]))?.[1]);
    expect(chunkStart).toBeGreaterThan(1);
    expect(defined(calls.at(-1)).questions).toHaveProperty("a#line");
    expect(defined(calls.at(-1)).state).toMatchObject({ startLine: chunkStart });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      range: { line: chunkStart },
      score: 0.81,
      data: { stage: "line", chunk: { key: "7" } },
    });
  });

  it("tries adjacent chunks before falling back to the best line", async () => {
    const options = parse({
      questions: {
        a: {
          type: "noul",
          instructions: "A?",
          locate: { chunkLines: 15, lineMin: 0.5 },
        },
      },
    });
    const client = fakeClient([
      response({
        a: { type: "noul", noul: 0.9 },
        "a#chunk": { type: "choice", choice: "1", confidence: 0.9 },
      }),
      response({
        "a#line": {
          type: "choice",
          choice: "1",
          confidence: 0.4,
          probabilities: { "1": 0.4, "2": 0.3 },
        },
      }),
      response({
        "a#line": {
          type: "choice",
          choice: "14",
          confidence: 0.8,
          probabilities: { "14": 0.8 },
        },
      }),
    ]);

    const diagnostics = await runJevFunnel({
      document: documentOf(30),
      options,
      client,
    });

    expect(client.calls).toHaveLength(3);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      range: { line: 14, column: 1, endLine: 14, endColumn: 8 },
      score: 0.72,
      data: {
        stage: "line",
        lineProbability: 0.8,
        chunk: { key: "2", lines: [14, 30], probability: 1 },
      },
    });
  });

  it("issues refine requests for multiple hits in parallel", async () => {
    const options = parse({
      questions: {
        a: { type: "noul", instructions: "A?", locate: true },
        b: { type: "noul", instructions: "B?", locate: true },
      },
    });
    const client = fakeClient([
      response({
        a: { type: "noul", noul: 0.9 },
        "a#chunk": { type: "choice", choice: "1", confidence: 0.9 },
        b: { type: "noul", noul: 0.9 },
        "b#chunk": { type: "choice", choice: "2", confidence: 0.9 },
      }),
      response({
        "a#line": {
          type: "choice",
          choice: "3",
          confidence: 0.9,
          probabilities: { "3": 0.9 },
        },
      }),
      response({
        "b#line": {
          type: "choice",
          choice: "20",
          confidence: 0.9,
          probabilities: { "20": 0.9 },
        },
      }),
    ]);

    const diagnostics = await runJevFunnel({
      document: documentOf(30),
      options,
      client,
    });

    expect(client.calls).toHaveLength(3);
    expect(client.calls[1]?.questions).toHaveProperty("a#line");
    expect(client.calls[2]?.questions).toHaveProperty("b#line");
    expect(diagnostics.map((diagnostic) => diagnostic.range.line)).toEqual([
      3, 20,
    ]);
  });

  it("batches classify questions when the state leaves no room", async () => {
    const filler = "x".repeat(400);
    const options = parse({
      contextTokens: 500,
      reservedOutputTokens: 100,
      questions: {
        a: { type: "noul", instructions: `A? ${filler}` },
        b: { type: "noul", instructions: `B? ${filler}` },
        c: { type: "noul", instructions: `C? ${filler}` },
      },
    });
    const client = fakeClient([
      response({ a: { type: "noul", noul: 0.9 } }),
      response({ b: { type: "noul", noul: 0.9 } }),
      response({ c: { type: "noul", noul: 0.9 } }),
    ]);

    const diagnostics = await runJevFunnel({
      document: documentOf(30),
      options,
      client,
    });

    expect(client.calls).toHaveLength(3);
    for (const call of client.calls) {
      expect(Object.keys(call.questions)).toHaveLength(1);
    }
    expect(diagnostics.map((diagnostic) => diagnostic.ruleId)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("keeps the chunk finding when the refine request cannot fit", async () => {
    const options = parse({
      contextTokens: 500,
      reservedOutputTokens: 100,
      questions: {
        a: { type: "noul", instructions: "A?", locate: { chunkLines: 40 } },
      },
    });
    const client = fakeClient([
      response({ a: { type: "noul", noul: 0.9 } }),
    ]);

    const diagnostics = await runJevFunnel({
      document: documentOf(40),
      options,
      client,
    });

    expect(client.calls).toHaveLength(1);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      range: { line: 1, endLine: 40 },
      data: {
        stage: "chunk",
        chunk: { key: "1", lines: [1, 40], probability: 1 },
      },
    });
  });

  it("reuses refinement cache entries when edits stay outside the section", async () => {
    const entries = new Map<string, JevResponse>();
    const cache: JevFunnelCache = {
      async get(key) {
        return entries.get(key);
      },
      async set(key, value) {
        entries.set(key, value);
      },
    };
    const options = parse({
      questions: {
        a: { type: "noul", instructions: "A?", locate: { chunkLines: 5 } },
      },
    });

    const first = fakeClient([
      response({
        a: { type: "noul", noul: 0.9 },
        "a#chunk": { type: "choice", choice: "1", confidence: 0.9 },
      }),
      response({
        "a#line": {
          type: "choice",
          choice: "1",
          confidence: 0.9,
          probabilities: { "1": 0.9 },
        },
      }),
    ]);
    const initial = await runJevFunnel({
      document: documentOf(10),
      options,
      client: first,
      cache,
    });
    expect(initial).toHaveLength(1);
    expect(entries.size).toBe(2);

    const second = fakeClient([
      response({
        a: { type: "noul", noul: 0.9 },
        "a#chunk": { type: "choice", choice: "1", confidence: 0.9 },
      }),
    ]);
    const cached = await runJevFunnel({
      document: documentOf(20),
      options,
      client: second,
      cache,
    });
    expect(second.calls).toHaveLength(1);
    expect(cached).toHaveLength(1);
  });

  it("reads through and writes the cache", async () => {
    const entries = new Map<string, JevResponse>();
    const cache: JevFunnelCache = {
      async get(key) {
        return entries.get(key);
      },
      async set(key, value) {
        entries.set(key, value);
      },
    };
    const options = parse({
      questions: { a: { type: "noul", instructions: "A?" } },
    });

    const first = fakeClient([response({ a: { type: "noul", noul: 0.9 } })]);
    const initial = await runJevFunnel({
      document: documentOf(2),
      options,
      client: first,
      cache,
    });
    expect(initial).toHaveLength(1);
    expect(entries.size).toBe(1);

    const second = fakeClient([]);
    const cached = await runJevFunnel({
      document: documentOf(2),
      options,
      client: second,
      cache,
    });
    expect(second.calls).toHaveLength(0);
    expect(cached).toHaveLength(1);
  });
});

describe("jevRule", () => {
  it("has no opt-in flag and validates its options", () => {
    expect("optIn" in jevRule.meta).toBe(false);
    expect(() => jevRule.validateOptions?.({})).not.toThrow();
    expect(() => jevRule.validateOptions?.({ questions: {} })).toThrowError(
      ConfigError,
    );
  });

  it("returns no diagnostics and makes no request without questions", async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);

    const result = await jevRule.check(documentOf(2), { cwd: ".", options: {} });

    expect(result).toEqual({ diagnostics: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("skips files above maxFileBytes with a notice", async () => {
    const result = await jevRule.check(documentOf(2), {
      cwd: ".",
      options: parse({
        maxFileBytes: 4,
        questions: { a: { type: "noul", instructions: "A?" } },
      }),
    });

    expect(result).toMatchObject({ diagnostics: [] });
    const notices = Array.isArray(result) ? [] : (result.notices ?? []);
    expect(notices[0]).toMatch(/above maxFileBytes \(4\)/);
  });

  it("asks Jev about the document and maps the answers", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    const calls: RequestInit[] = [];
    const fetchImpl = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      calls.push(init ?? {});
      return new Response(
        JSON.stringify({
          model: MODEL,
          answers: { urgent: { type: "noul", noul: 0.93 } },
          usage: USAGE,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    vi.stubGlobal("fetch", fetchImpl);

    const result = await jevRule.check(documentOf(2), {
      cwd: ".",
      options: parse({
        questions: {
          urgent: {
            type: "noul",
            instructions: "Urgent?",
            report: { min: 0.9, message: "urgent" },
          },
        },
      }),
    });
    const diagnostics = Array.isArray(result) ? result : result.diagnostics;

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      ruleId: "urgent",
      message: "urgent",
      path: "src/a.ts",
    });

    const request = JSON.parse(String(defined(calls[0]).body)) as Record<
      string,
      unknown
    >;
    expect(request.state).toEqual({
      path: "src/a.ts",
      language: "typescript",
      text: "line 1\nline 2\n",
    });
    expect(request.questions).toEqual({
      urgent: { type: "noul", instructions: "Urgent?" },
    });
  });

  it("reports skipped localization as a notice", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          model: MODEL,
          answers: { a: { type: "noul", noul: 0.9 } },
          usage: USAGE,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    vi.stubGlobal("fetch", fetchImpl);

    const result = await jevRule.check(
      createDocument("src/a.ts", `${"x".repeat(90_000)}\n`),
      {
        cwd: ".",
        options: parse({
          questions: { a: { type: "noul", instructions: "A?", locate: true } },
        }),
      },
    );

    const notices = Array.isArray(result) ? [] : (result.notices ?? []);
    expect(notices[0]).toMatch(/localization skipped/);
  });

  it("reports a missing API key as a rule error", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");

    await expect(
      jevRule.check(documentOf(2), {
        cwd: ".",
        options: parse({
          questions: { a: { type: "noul", instructions: "A?" } },
        }),
      }),
    ).rejects.toThrowError(JevError);
  });

  it("reuses cached answers when cache is enabled", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    const dir = await mkdtemp(path.join(tmpdir(), "flint-jev-cache-"));
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          model: MODEL,
          answers: { a: { type: "noul", noul: 0.9 } },
          usage: USAGE,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    vi.stubGlobal("fetch", fetchImpl);

    try {
      const options = parse({
        cache: true,
        questions: { a: { type: "noul", instructions: "A?" } },
      });
      const first = await jevRule.check(documentOf(2), { cwd: dir, options });
      const second = await jevRule.check(documentOf(2), { cwd: dir, options });

      expect(Array.isArray(first) ? first : first.diagnostics).toHaveLength(1);
      expect(Array.isArray(second) ? second : second.diagnostics).toHaveLength(1);
      expect(calls).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
