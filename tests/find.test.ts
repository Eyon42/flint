import { stat } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  findCommand,
  type FindCommandDeps,
  type FindCommandOptions,
} from "../src/commands/find.js";
import { resetJevState } from "../src/lib/ai/jev.js";
import { UsageError } from "../src/lib/errors.js";
import { findQuestion } from "../src/lib/lint/rules/find.js";
import {
  createTempDir,
  defined,
  removeTempDir,
  writeFiles,
} from "./helpers.js";

const MODEL = "typesafe/jev-1.13";
const USAGE = { input_tokens: 10, output_tokens: 2 };

interface Call {
  url: string;
  body: Record<string, unknown>;
}

function routeFetch(
  handler: (body: Record<string, unknown>) => unknown,
): { calls: Call[]; fetch: typeof fetch } {
  const calls: Call[] = [];
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ url: String(input), body });
    return new Response(JSON.stringify(handler(body)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, fetch: fetchImpl };
}

function response(answers: Record<string, unknown>): unknown {
  return { model: MODEL, answers, usage: USAGE };
}

function questionKeys(body: Record<string, unknown>): string[] {
  return Object.keys((body.questions ?? {}) as Record<string, unknown>);
}

function findAnswers(body: Record<string, unknown>): unknown {
  if (questionKeys(body).includes("find#line")) {
    return response({
      "find#line": {
        type: "choice",
        choice: "2",
        confidence: 0.8,
        probabilities: { "1": 0.1, "2": 0.8, "3": 0.1 },
      },
    });
  }
  return response({ find: { type: "noul", noul: 0.9 } });
}

interface Captured {
  output: string;
  code: number;
}

describe("findQuestion", () => {
  it("wraps the query in a localized noul question", () => {
    const question = findQuestion({ query: "  all uses of Promise.all  " });

    expect(question.type).toBe("noul");
    expect(question.instructions).toContain("all uses of Promise.all");
    expect(question.report).toEqual({
      message: "all uses of Promise.all",
      min: 0.8,
      severity: "info",
    });
    expect(question).toMatchObject({ locate: { lineMin: 0.3 } });
  });

  it("accepts severity, min, and lineMin overrides", () => {
    const question = findQuestion({
      query: "cows",
      severity: "error",
      min: 0.5,
      lineMin: 0.4,
    });

    expect(question.report).toEqual({
      message: "cows",
      min: 0.5,
      severity: "error",
    });
    expect(question).toMatchObject({ locate: { lineMin: 0.4 } });
  });
});

describe("findCommand", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createTempDir();
    resetJevState();
  });

  afterEach(async () => {
    await removeTempDir(dir);
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    resetJevState();
  });

  async function run(
    query: string,
    patterns: string[] = [],
    options: FindCommandOptions = {},
    deps: FindCommandDeps = {},
  ): Promise<Captured> {
    let output = "";
    const code = await findCommand(query, patterns, { format: "json", ...options }, {
      cwd: dir,
      isTty: false,
      write: (text) => {
        output += text;
      },
      ...deps,
    });
    return { output, code };
  }

  it("runs the query as a localized find and reports matches as info", async () => {
    await writeFiles(dir, { "a.ts": "cow\ncow\ncow\n" });
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    const { calls, fetch } = routeFetch(findAnswers);
    vi.stubGlobal("fetch", fetch);

    const { output, code } = await run("cow");
    const payload = JSON.parse(output);

    expect(code).toBe(0);
    expect(calls).toHaveLength(2);
    expect(questionKeys(defined(calls[0]).body)).toEqual(["find"]);
    expect(questionKeys(defined(calls[1]).body)).toEqual(["find#line"]);
    expect(payload.diagnostics).toHaveLength(1);
    expect(payload.diagnostics[0]).toMatchObject({
      ruleId: "find",
      severity: "info",
      message: "cow",
      score: 0.72,
      path: "a.ts",
      range: { line: 2, column: 1, endLine: 2, endColumn: 4 },
      data: {
        questionId: "find",
        stage: "line",
        noul: 0.9,
        lineProbability: 0.8,
        model: MODEL,
      },
    });
    expect(payload.summary).toMatchObject({ infoCount: 1, errorCount: 0 });
    expect(payload.summary.ai).toMatchObject({ requests: 2 });
  });

  it("ignores questions configured for lint", async () => {
    await writeFiles(dir, {
      "flint.config.ts": `export default {
  rules: {
    jev: {
      options: {
        questions: {
          "no-cow": { type: "noul", instructions: "The file mentions a cow" },
        },
      },
    },
  },
};
`,
      "a.ts": "cow\n",
    });
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    const { calls, fetch } = routeFetch(findAnswers);
    vi.stubGlobal("fetch", fetch);

    const { code } = await run("cow");

    expect(code).toBe(0);
    expect(questionKeys(defined(calls[0]).body)).toEqual(["find"]);
  });

  it("honors config rule options such as maxFileBytes", async () => {
    await writeFiles(dir, {
      "flint.config.ts": `export default {
  rules: { jev: { options: { maxFileBytes: 2 } } },
};
`,
      "a.ts": "cow\n",
    });
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);

    const { output, code } = await run("cow", ["a.ts"]);
    const payload = JSON.parse(output);

    expect(code).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(payload.notices).toHaveLength(1);
    expect(payload.notices[0].message).toMatch(/above maxFileBytes \(2\)/);
  });

  it("returns 1 when matches are escalated to error severity", async () => {
    await writeFiles(dir, { "a.ts": "cow\ncow\ncow\n" });
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    const { fetch } = routeFetch(findAnswers);
    vi.stubGlobal("fetch", fetch);

    const { output, code } = await run("cow", [], { severity: "error" });
    const payload = JSON.parse(output);

    expect(code).toBe(1);
    expect(payload.summary.errorCount).toBe(1);
    expect(payload.diagnostics[0].severity).toBe("error");
  });

  it("applies the --min threshold", async () => {
    await writeFiles(dir, { "a.ts": "cow\n" });
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    const { calls, fetch } = routeFetch(findAnswers);
    vi.stubGlobal("fetch", fetch);

    const { output, code } = await run("cow", [], { min: 0.95 });
    const payload = JSON.parse(output);

    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(payload.diagnostics).toEqual([]);
  });

  it("applies the --line-min threshold and falls back to the best line", async () => {
    await writeFiles(dir, { "a.ts": "cow\ncow\ncow\n" });
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    const { fetch } = routeFetch((body) => {
      if (questionKeys(body).includes("find#line")) {
        return response({
          "find#line": {
            type: "choice",
            choice: "2",
            confidence: 0.5,
            probabilities: { "1": 0.1, "2": 0.5, "3": 0.4 },
          },
        });
      }
      return response({ find: { type: "noul", noul: 0.9 } });
    });
    vi.stubGlobal("fetch", fetch);

    const { output } = await run("cow", [], { lineMin: 0.6 });
    const payload = JSON.parse(output);

    expect(payload.diagnostics).toHaveLength(1);
    expect(payload.diagnostics[0].range.line).toBe(2);
  });

  it("never reads or writes the cache, even when config enables it", async () => {
    await writeFiles(dir, {
      "flint.config.ts": `export default {
  rules: { jev: { options: { cache: true } } },
};
`,
      "a.ts": "cow\ncow\ncow\n",
    });
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    const { calls, fetch } = routeFetch(findAnswers);
    vi.stubGlobal("fetch", fetch);

    const first = await run("cow", ["a.ts"]);
    const second = await run("cow", ["a.ts"]);

    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    expect(calls).toHaveLength(4);
    await expect(stat(path.join(dir, ".flint-cache"))).rejects.toThrow();
  });

  it("reports a missing API key as a tool diagnostic with exit 1", async () => {
    await writeFiles(dir, { "a.ts": "cow\n" });
    vi.stubEnv("OPENROUTER_API_KEY", "");

    const { output, code } = await run("cow");
    const payload = JSON.parse(output);

    expect(code).toBe(1);
    expect(payload.toolDiagnostics).toHaveLength(1);
    expect(payload.toolDiagnostics[0].message).toMatch(/OPENROUTER_API_KEY/);
  });

  it("searches stdin content through the memory provider", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    const { fetch } = routeFetch(findAnswers);
    vi.stubGlobal("fetch", fetch);

    const { output, code } = await run(
      "cow",
      [],
      { stdin: true, stdinFilename: "piped.ts" },
      { readStdin: async () => "cow\ncow\ncow\n" },
    );
    const payload = JSON.parse(output);

    expect(code).toBe(0);
    expect(payload.diagnostics[0].path).toBe("piped.ts");
    expect(payload.diagnostics[0].range.line).toBe(2);
  });

  it("uses config include when no patterns are given", async () => {
    await writeFiles(dir, {
      "flint.config.ts": 'export default { include: ["src/**/*.ts"] };\n',
      "src/a.ts": "cow\n",
      "other.ts": "cow cow\n",
    });
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    const { fetch } = routeFetch(findAnswers);
    vi.stubGlobal("fetch", fetch);

    const { output } = await run("cow");
    const payload = JSON.parse(output);

    expect(payload.summary.filesLinted).toBe(1);
  });

  it("warns when explicit patterns match no files", async () => {
    await writeFiles(dir, { "a.ts": "cow\n" });
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);

    const { output, code } = await run("cow", ["missing.ts"]);
    const payload = JSON.parse(output);

    expect(code).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(payload.notices[0].message).toMatch(/no files matched/);
  });

  it("rejects an empty query", async () => {
    await expect(run("   ")).rejects.toThrow(UsageError);
  });
});
