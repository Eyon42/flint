import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lintCommand } from "../src/commands/lint.js";
import { resetJevState } from "../src/lib/ai/jev.js";
import { UsageError } from "../src/lib/errors.js";
import {
  createTempDir,
  defined,
  removeTempDir,
  writeFiles,
} from "./helpers.js";

const MODEL = "typesafe/jev-1.13";
const USAGE = { input_tokens: 10, output_tokens: 2 };

const JEV_CONFIG = `export default {
  rules: {
    jev: {
      options: {
        questions: {
          "no-cow": {
            type: "noul",
            instructions: "The file mentions a cow",
            report: { min: 0.5 },
            locate: { chunkLines: 5, lineMin: 0.3 },
          },
        },
      },
    },
  },
};
`;

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

function cowAnswers(body: Record<string, unknown>): unknown {
  if (questionKeys(body).includes("no-cow#line")) {
    return response({
      "no-cow#line": {
        type: "choice",
        choice: "2",
        confidence: 0.8,
        probabilities: { "1": 0.1, "2": 0.8, "3": 0.1 },
      },
    });
  }
  return response({ "no-cow": { type: "noul", noul: 0.9 } });
}

interface Captured {
  output: string;
  code: number;
}

describe("lintCommand", () => {
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
    patterns: string[],
    options: Parameters<typeof lintCommand>[1] = {},
    deps: Parameters<typeof lintCommand>[2] = {},
  ): Promise<Captured> {
    let output = "";
    const code = await lintCommand(patterns, { format: "json", ...options }, {
      cwd: dir,
      isTty: false,
      write: (text) => {
        output += text;
      },
      ...deps,
    });
    return { output, code };
  }

  it("reports AI findings with score and data in JSON", async () => {
    await writeFiles(dir, {
      "flint.config.ts": JEV_CONFIG,
      "a.ts": "cow\ncow\ncow\n",
    });
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    const { calls, fetch } = routeFetch(cowAnswers);
    vi.stubGlobal("fetch", fetch);

    const { output, code } = await run(["a.ts"]);
    const payload = JSON.parse(output);

    expect(code).toBe(0);
    expect(calls).toHaveLength(2);
    expect(defined(calls[0]).url).toBe(
      "https://openrouter.ai/api/alpha/decisions",
    );
    expect(questionKeys(defined(calls[0]).body)).toEqual(["no-cow"]);
    expect(questionKeys(defined(calls[1]).body)).toEqual(["no-cow#line"]);
    expect(payload.diagnostics).toHaveLength(1);
    expect(payload.diagnostics[0]).toMatchObject({
      ruleId: "no-cow",
      score: 0.72,
      path: "a.ts",
      range: { line: 2, column: 1, endLine: 2, endColumn: 4 },
      data: {
        questionId: "no-cow",
        stage: "line",
        noul: 0.9,
        lineProbability: 0.8,
        model: MODEL,
      },
    });
    expect(payload.notices).toEqual([]);
    expect(payload.summary.ai).toMatchObject({
      requests: 2,
      inputTokens: 20,
      outputTokens: 4,
    });
  });

  it("renders AI findings as pretty code frames by default", async () => {
    await writeFiles(dir, {
      "flint.config.ts": JEV_CONFIG,
      "a.ts": "cow\ncow\ncow\n",
    });
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    const { fetch } = routeFetch(cowAnswers);
    vi.stubGlobal("fetch", fetch);

    const { output, code } = await run(["a.ts"], { format: undefined });

    expect(code).toBe(0);
    expect(output).toContain("a.ts");
    expect(output).toContain("│");
    expect(output).toContain("no-cow");
    expect(output).toContain("0.72");
  });

  it("reports a missing API key as a tool diagnostic with exit 1", async () => {
    await writeFiles(dir, { "flint.config.ts": JEV_CONFIG, "a.ts": "cow\n" });
    vi.stubEnv("OPENROUTER_API_KEY", "");

    const { output, code } = await run(["a.ts"]);
    const payload = JSON.parse(output);

    expect(code).toBe(1);
    expect(payload.toolDiagnostics).toHaveLength(1);
    expect(payload.toolDiagnostics[0].message).toMatch(/OPENROUTER_API_KEY/);
  });

  it("returns 1 when the configured severity is error", async () => {
    await writeFiles(dir, {
      "flint.config.ts": `export default {
  rules: {
    jev: {
      severity: "error",
      options: {
        questions: {
          "no-cow": {
            type: "noul",
            instructions: "The file mentions a cow",
            report: { min: 0.5 },
          },
        },
      },
    },
  },
};
`,
      "a.ts": "cow\n",
    });
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    const { fetch } = routeFetch(() =>
      response({ "no-cow": { type: "noul", noul: 0.9 } }),
    );
    vi.stubGlobal("fetch", fetch);

    const { output, code } = await run(["a.ts"]);
    const payload = JSON.parse(output);

    expect(code).toBe(1);
    expect(payload.summary.errorCount).toBe(1);
  });

  it("counts AI warnings toward maxWarnings", async () => {
    await writeFiles(dir, {
      "flint.config.ts": JEV_CONFIG,
      "a.ts": "cow\ncow\ncow\n",
    });
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    const { fetch } = routeFetch(cowAnswers);
    vi.stubGlobal("fetch", fetch);

    const { output, code } = await run(["a.ts"], { maxWarnings: 0 });
    const payload = JSON.parse(output);

    expect(code).toBe(1);
    expect(payload.summary.warningCount).toBe(1);
  });

  it("makes no AI requests when no questions are configured", async () => {
    await writeFiles(dir, { "a.ts": "cow\n" });
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);

    const { output, code } = await run(["a.ts"]);
    const payload = JSON.parse(output);

    expect(code).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(payload.diagnostics).toEqual([]);
    expect(payload.summary.ai).toBeUndefined();
  });

  it("emits a skip notice for files above maxFileBytes", async () => {
    await writeFiles(dir, {
      "flint.config.ts": `export default {
  rules: {
    jev: {
      options: {
        maxFileBytes: 2,
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
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);

    const { output, code } = await run(["a.ts"]);
    const payload = JSON.parse(output);

    expect(code).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(payload.notices).toHaveLength(1);
    expect(payload.notices[0].message).toMatch(/above maxFileBytes \(2\)/);
  });

  it("lints stdin content through the memory provider", async () => {
    await writeFiles(dir, { "flint.config.ts": JEV_CONFIG });
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    const { fetch } = routeFetch(cowAnswers);
    vi.stubGlobal("fetch", fetch);

    const { output, code } = await run([], {
      stdin: true,
      stdinFilename: "piped.ts",
    }, { readStdin: async () => "cow\ncow\ncow\n" });
    const payload = JSON.parse(output);

    expect(code).toBe(0);
    expect(payload.diagnostics[0].path).toBe("piped.ts");
    expect(payload.diagnostics[0].range.line).toBe(2);
  });

  it("rejects --stdin-filename without --stdin", async () => {
    await expect(run([], { stdinFilename: "piped.ts" })).rejects.toThrow(UsageError);
  });

  it("uses config include when no patterns are given", async () => {
    await writeFiles(dir, {
      "flint.config.ts": 'export default { include: ["src/**/*.ts"] };\n',
      "src/a.ts": "cow\n",
      "other.ts": "cow cow\n",
    });

    const { output } = await run([]);
    const payload = JSON.parse(output);

    expect(payload.summary.filesLinted).toBe(1);
    expect(payload.diagnostics).toEqual([]);
  });

  it("warns when explicit patterns match no files", async () => {
    await writeFiles(dir, { "a.ts": "cow\n" });

    const { output, code } = await run(["missing.ts"]);
    const payload = JSON.parse(output);

    expect(code).toBe(0);
    expect(payload.notices).toHaveLength(1);
    expect(payload.notices[0].message).toMatch(/no files matched/);
    expect(payload.notices[0].message).toContain("flint --help");
  });

  it("does not warn when the pattern matches", async () => {
    await writeFiles(dir, { "a.ts": "cow\n" });

    const { output } = await run(["a.ts"]);
    const payload = JSON.parse(output);

    expect(payload.notices).toEqual([]);
  });
});
