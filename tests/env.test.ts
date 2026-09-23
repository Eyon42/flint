import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadDotEnv } from "../src/lib/env.js";

const KEY = "FLINT_TEST_DOTENV";

afterEach(() => {
  delete process.env[KEY];
});

async function withTempDir(
  files: Record<string, string>,
  fn: (dir: string) => void,
): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "flint-env-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      await writeFile(path.join(dir, name), content, "utf8");
    }
    fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("loadDotEnv", () => {
  it("loads variables from .env in the working directory", async () => {
    await withTempDir({ ".env": `${KEY}=from-file\n` }, (dir) => {
      delete process.env[KEY];
      loadDotEnv(dir);
      expect(process.env[KEY]).toBe("from-file");
    });
  });

  it("does not override variables already in the environment", async () => {
    await withTempDir({ ".env": `${KEY}=from-file\n` }, (dir) => {
      process.env[KEY] = "from-shell";
      loadDotEnv(dir);
      expect(process.env[KEY]).toBe("from-shell");
    });
  });

  it("is a no-op when .env is missing", async () => {
    await withTempDir({}, (dir) => {
      delete process.env[KEY];
      expect(() => {
        loadDotEnv(dir);
      }).not.toThrow();
      expect(process.env[KEY]).toBeUndefined();
    });
  });
});
