import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createJevClient,
  getJevClient,
  getJevStats,
  JEV_DEFAULT_BASE_URL,
  JEV_DEFAULT_MODEL,
  JevError,
  resetJevState,
} from "../src/lib/ai/jev.js";
import { defined } from "./helpers.js";

interface Call {
  url: string;
  init: RequestInit;
}

type FetchHandler = (call: Call) => Response | Promise<Response>;

function fakeFetch(handler: FetchHandler): {
  calls: Call[];
  fetch: typeof fetch;
} {
  const calls: Call[] = [];
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { calls, fetch: fetchImpl };
}

function json(
  payload: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function requestBody(call: Call): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

const QUESTIONS = {
  urgency: { type: "noul" as const, instructions: "Is this urgent?" },
};

const RESPONSE = {
  id: "gen-dec-1",
  model: "typesafe/jev-1.13-20260917",
  provider: "TypeSafe",
  answers: { urgency: { type: "noul", noul: 0.97 } },
  usage: { input_tokens: 12, output_tokens: 3, cost: 0.00002 },
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetJevState();
});

describe("createJevClient", () => {
  it("posts to the OpenRouter Decisions API and parses the response", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    const { calls, fetch } = fakeFetch(() => json(RESPONSE));

    const client = createJevClient({ fetch });
    const response = await client.decide({
      state: "ship it",
      questions: QUESTIONS,
    });

    expect(calls).toHaveLength(1);
    expect(defined(calls[0]).url).toBe(`${JEV_DEFAULT_BASE_URL}/alpha/decisions`);
    expect(defined(calls[0]).init.method).toBe("POST");
    const headers = new Headers(defined(calls[0]).init.headers);
    expect(headers.get("authorization")).toBe("Bearer sk-or-test");
    expect(headers.get("content-type")).toBe("application/json");
    expect(requestBody(defined(calls[0]))).toEqual({
      model: JEV_DEFAULT_MODEL,
      state: "ship it",
      questions: QUESTIONS,
    });
    expect(response).toEqual(RESPONSE);
  });

  it("supports base URL, model, session, and header overrides", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    const { calls, fetch } = fakeFetch(() => json(RESPONSE));

    const client = createJevClient({
      fetch,
      model: "typesafe/jev-1.13",
      baseUrl: "https://gateway.example.com/api/",
      headers: { "http-referer": "https://flint.example" },
    });
    await client.decide({
      state: {},
      questions: QUESTIONS,
      model: "~typesafe/jev-latest",
      sessionId: "session-1",
    });

    expect(defined(calls[0]).url).toBe(
      "https://gateway.example.com/api/alpha/decisions",
    );
    expect(
      new Headers(defined(calls[0]).init.headers).get("http-referer"),
    ).toBe("https://flint.example");
    expect(requestBody(defined(calls[0]))).toMatchObject({
      model: "~typesafe/jev-latest",
      session_id: "session-1",
    });
  });

  it("requires an OpenRouter API key", () => {
    vi.stubEnv("OPENROUTER_API_KEY", "");
    const { fetch } = fakeFetch(() => json(RESPONSE));
    expect(() => createJevClient({ fetch })).toThrowError(JevError);
  });

  it("parses choice answers and answers without an explicit type", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    const { fetch } = fakeFetch(() =>
      json({
        model: "typesafe/jev-1.13",
        answers: {
          team: {
            type: "choice",
            choice: "payments",
            confidence: 0.75,
            probabilities: { account: 0.1, payments: 0.9 },
          },
          urgency: {
            score: 1.99,
            confidence: 0.99,
            legend: { "0": "wait", "1": "week", "2": "now" },
          },
        },
        usage: { input_tokens: 20, output_tokens: 4 },
      }),
    );

    const response = await createJevClient({ fetch }).decide({
      state: "x",
      questions: QUESTIONS,
    });

    expect(response.answers.team).toEqual({
      type: "choice",
      choice: "payments",
      confidence: 0.75,
      probabilities: { account: 0.1, payments: 0.9 },
    });
    expect(response.answers.urgency).toEqual({
      type: "score",
      score: 1.99,
      confidence: 0.99,
      legend: { "0": "wait", "1": "week", "2": "now" },
    });
  });

  it("retries retryable statuses and honors retry-after", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    let attempts = 0;
    const { calls, fetch } = fakeFetch(() => {
      attempts += 1;
      return attempts === 1
        ? json({ error: "slow down" }, 429, { "retry-after": "0" })
        : json(RESPONSE);
    });

    const response = await createJevClient({ fetch }).decide({
      state: "x",
      questions: QUESTIONS,
    });

    expect(calls).toHaveLength(2);
    expect(response.model).toBe(RESPONSE.model);
  });

  it("does not retry non-retryable errors", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    const { calls, fetch } = fakeFetch(() =>
      json({ error: { message: "no key" } }, 401),
    );

    await expect(
      createJevClient({ fetch }).decide({ state: "x", questions: QUESTIONS }),
    ).rejects.toMatchObject({ name: "JevError", status: 401 });
    expect(calls).toHaveLength(1);
  });

  it("stops retrying after the retry budget", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    const { calls, fetch } = fakeFetch(() => json({ error: "boom" }, 500));

    await expect(
      createJevClient({ fetch, maxRetries: 1, retryDelayMs: 0 }).decide({
        state: "x",
        questions: QUESTIONS,
      }),
    ).rejects.toMatchObject({ status: 500 });
    expect(calls).toHaveLength(2);
  });

  it("rejects malformed responses", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    const { fetch } = fakeFetch(() => new Response("not json", { status: 200 }));

    await expect(
      createJevClient({ fetch }).decide({ state: "x", questions: QUESTIONS }),
    ).rejects.toThrowError(/not valid JSON/);
  });

  it("times out slow requests", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    const { fetch } = fakeFetch(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          call.init.signal?.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        }),
    );

    await expect(
      createJevClient({ fetch, timeoutMs: 5, maxRetries: 0 }).decide({
        state: "x",
        questions: QUESTIONS,
      }),
    ).rejects.toThrowError(/timed out after 5ms/);
  });

  it("memoizes clients per model", () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    resetJevState();

    const first = getJevClient("typesafe/jev-1.13");
    expect(getJevClient("typesafe/jev-1.13")).toBe(first);
    expect(getJevClient("typesafe/jev-other")).not.toBe(first);
  });

  it("caps in-flight requests with the concurrency limiter", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    let active = 0;
    let peak = 0;
    const { fetch } = fakeFetch(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return json(RESPONSE);
    });

    const client = createJevClient({ fetch, maxConcurrency: 1 });
    await Promise.all([
      client.decide({ state: "a", questions: QUESTIONS }),
      client.decide({ state: "b", questions: QUESTIONS }),
      client.decide({ state: "c", questions: QUESTIONS }),
    ]);

    expect(peak).toBe(1);
  });

  it("enforces the request budget without a network call", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    const { calls, fetch } = fakeFetch(() => json(RESPONSE));
    const client = createJevClient({ fetch, maxRequests: 1 });

    await client.decide({ state: "a", questions: QUESTIONS });
    await expect(
      client.decide({ state: "b", questions: QUESTIONS }),
    ).rejects.toThrowError(/budget exceeded/);
    expect(calls).toHaveLength(1);
  });

  it("accumulates usage stats across attempts and clients", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    let attempts = 0;
    const { fetch } = fakeFetch(() => {
      attempts += 1;
      return attempts === 1
        ? json({ error: "slow down" }, 429, { "retry-after": "0" })
        : json(RESPONSE);
    });

    await createJevClient({ fetch }).decide({
      state: "x",
      questions: QUESTIONS,
    });

    expect(getJevStats()).toEqual({
      requests: 2,
      decisions: 1,
      inputTokens: 12,
      outputTokens: 3,
      cost: 0.00002,
    });
  });
});
