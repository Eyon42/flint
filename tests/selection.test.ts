import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Target } from "../src/lib/lint/types.js";
import { selectTargets } from "../src/lib/lint/selection.js";
import { createTempDir, removeTempDir, writeFiles } from "./helpers.js";

function target(filePath: string): Target {
  return { path: filePath, source: "fs" };
}

describe("selectTargets", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createTempDir();
  });

  afterEach(async () => {
    await removeTempDir(dir);
  });

  it("dedupes, applies .gitignore, and skips default excluded directories", async () => {
    await writeFiles(dir, {
      ".gitignore": "ignored.txt\n",
      "src/a.ts": "a",
      "ignored.txt": "x",
      "node_modules/pkg/b.ts": "b",
      ".git/hooks/example": "h",
    });

    const result = await selectTargets(
      [
        target("src/a.ts"),
        target("ignored.txt"),
        target("node_modules/pkg/b.ts"),
        target(".git/hooks/example"),
        target("src/a.ts"),
      ],
      { cwd: dir },
    );

    expect(result.targets.map((entry) => entry.path)).toEqual(["src/a.ts"]);
    expect(result.considered).toBe(4);
    expect(result.skipped.ignored).toBe(3);
  });

  it("applies extra ignore patterns", async () => {
    await writeFiles(dir, { "a.ts": "a", "b.ts": "b" });

    const result = await selectTargets([target("a.ts"), target("b.ts")], {
      cwd: dir,
      ignores: ["a.ts"],
    });

    expect(result.targets.map((entry) => entry.path)).toEqual(["b.ts"]);
    expect(result.skipped.ignored).toBe(1);
  });

  it("filters with the match regex", async () => {
    await writeFiles(dir, { "a.ts": "a", "b.md": "b" });

    const result = await selectTargets([target("a.ts"), target("b.md")], {
      cwd: dir,
      match: /\.ts$/,
    });

    expect(result.targets.map((entry) => entry.path)).toEqual(["a.ts"]);
    expect(result.skipped.filtered).toBe(1);
  });

  it("skips missing files", async () => {
    const result = await selectTargets([target("nope.ts")], { cwd: dir });

    expect(result.targets).toEqual([]);
    expect(result.skipped.missing).toBe(1);
  });

  it("skips binary files", async () => {
    await writeFiles(dir, {
      "bin.dat": Buffer.from([0x63, 0x6f, 0x77, 0x00, 0x01]),
      "text.txt": "cow",
    });

    const result = await selectTargets([target("bin.dat"), target("text.txt")], {
      cwd: dir,
    });

    expect(result.targets.map((entry) => entry.path)).toEqual(["text.txt"]);
    expect(result.skipped.binary).toBe(1);
  });

  it("skips files over the size limit", async () => {
    await writeFiles(dir, { "big.txt": "0123456789" });

    const result = await selectTargets([target("big.txt")], {
      cwd: dir,
      maxFileSize: 4,
    });

    expect(result.targets).toEqual([]);
    expect(result.skipped.tooLarge).toBe(1);
  });

  it("applies default excludes to paths outside the working directory", async () => {
    await writeFiles(dir, { "node_modules/pkg/a.ts": "a" });
    const outside = target(`${dir}/node_modules/pkg/a.ts`);

    const result = await selectTargets([outside], { cwd: `${dir}/nested` });

    expect(result.targets).toEqual([]);
    expect(result.skipped.ignored).toBe(1);
  });
});
