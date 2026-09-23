import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fsTargets } from "../src/lib/lint/sources/fs.js";
import {
  createTempDir,
  defined,
  removeTempDir,
  writeFiles,
} from "./helpers.js";

describe("fsTargets", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createTempDir();
    await writeFiles(dir, {
      "root.txt": "root",
      "README.md": "readme",
      "src/a.ts": "a",
      "src/nested/b.ts": "b",
      "node_modules/pkg/c.ts": "c",
    });
  });

  afterEach(async () => {
    await removeTempDir(dir);
  });

  it("resolves an explicit file", async () => {
    const targets = await fsTargets(["root.txt"], dir);
    expect(targets.map((entry) => entry.path)).toEqual(["root.txt"]);
    expect(defined(targets[0]).source).toBe("fs");
  });

  it("walks directories recursively", async () => {
    const targets = await fsTargets(["src"], dir);
    expect(targets.map((entry) => entry.path).toSorted()).toEqual([
      "src/a.ts",
      "src/nested/b.ts",
    ]);
  });

  it("resolves glob patterns", async () => {
    const targets = await fsTargets(["*.md"], dir);
    expect(targets.map((entry) => entry.path)).toEqual(["README.md"]);
  });

  it("dedupes overlapping patterns", async () => {
    const targets = await fsTargets(["src/**/*.ts", "src/a.ts"], dir);
    expect(targets.map((entry) => entry.path)).toEqual(["src/a.ts", "src/nested/b.ts"]);
  });
});
