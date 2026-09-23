import { stat } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProgram, type CliDeps, type CliState } from "../src/cli.js";
import { resetJevState } from "../src/lib/ai/jev.js";
import { createTempDir, removeTempDir, writeFiles } from "./helpers.js";

async function runCli(
  argv: string[],
  deps: CliDeps = {},
): Promise<{ code: number; output: string }> {
  const state: CliState = { exitCode: 0 };
  let output = "";
  const write = (text: string): void => {
    output += text;
  };
  const program = createProgram(state, {
    lint: { write, isTty: false, ...deps.lint },
    find: { write, isTty: false, ...deps.find },
    cache: { write, ...deps.cache },
  });
  await program.parseAsync(["node", "flint", ...argv]);
  return { code: state.exitCode, output };
}

describe("createProgram", () => {
  it("lints when no command is given", async () => {
    const dir = await createTempDir();
    try {
      await writeFiles(dir, { "a.ts": "export const a = 1;\n" });
      const { code, output } = await runCli([], { lint: { cwd: dir } });
      expect(code).toBe(0);
      expect(output).toContain("No issues found in 1 file.");
    } finally {
      await removeTempDir(dir);
    }
  });

  it("forwards positional arguments to the default lint command", async () => {
    const dir = await createTempDir();
    try {
      await writeFiles(dir, {
        "a.ts": "export const a = 1;\n",
        "b.ts": "export const b = 2;\n",
      });
      const { code, output } = await runCli(["b.ts"], {
        lint: { cwd: dir },
      });
      expect(code).toBe(0);
      expect(output).toContain("No issues found in 1 file.");
    } finally {
      await removeTempDir(dir);
    }
  });
});

describe("find", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetJevState();
  });

  it("dispatches the query and reports a missing API key", async () => {
    const dir = await createTempDir();
    try {
      await writeFiles(dir, { "a.ts": "export const a = 1;\n" });
      vi.stubEnv("OPENROUTER_API_KEY", "");
      const { code, output } = await runCli(["find", "all uses of a"], {
        find: { cwd: dir },
      });
      expect(code).toBe(1);
      expect(output).toContain("OPENROUTER_API_KEY");
    } finally {
      await removeTempDir(dir);
    }
  });

  it("requires a query and points to help", async () => {
    let text = "";
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        text += String(chunk);
        return true;
      });
    try {
      await expect(runCli(["find"])).rejects.toThrow(
        /missing required argument/,
      );
      expect(text).toContain("flint --help");
    } finally {
      stderr.mockRestore();
    }
  });
});

describe("command validation", () => {
  it("warns when an unrecognized command matches no files", async () => {
    const dir = await createTempDir();
    try {
      await writeFiles(dir, { "a.ts": "export const a = 1;\n" });
      const { code, output } = await runCli(["query", "all uses of a"], {
        lint: { cwd: dir },
      });
      expect(code).toBe(0);
      expect(output).toContain("no files matched");
      expect(output).toContain("flint --help");
    } finally {
      await removeTempDir(dir);
    }
  });

  it("lists commands and examples in help", async () => {
    let text = "";
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        text += String(chunk);
        return true;
      });
    try {
      await expect(runCli(["--help"])).rejects.toThrow();
    } finally {
      stdout.mockRestore();
    }
    expect(text).toContain("Commands:");
    expect(text).toContain("find");
    expect(text).toContain("Examples:");
  });
});

describe("cache clear", () => {
  it("removes the cache directory", async () => {
    const dir = await createTempDir();
    try {
      await writeFiles(dir, { ".flint-cache/jev/entry.json": "{}" });
      const { code, output } = await runCli(["cache", "clear"], {
        cache: { cwd: dir },
      });
      expect(code).toBe(0);
      expect(output).toBe("Cleared .flint-cache.\n");
      await expect(stat(path.join(dir, ".flint-cache"))).rejects.toThrow();
    } finally {
      await removeTempDir(dir);
    }
  });

  it("reports when there is nothing to clear", async () => {
    const dir = await createTempDir();
    try {
      const { code, output } = await runCli(["cache", "clear"], {
        cache: { cwd: dir },
      });
      expect(code).toBe(0);
      expect(output).toBe("No cache to clear.\n");
    } finally {
      await removeTempDir(dir);
    }
  });
});
