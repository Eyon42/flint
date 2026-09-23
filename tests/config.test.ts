import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError } from "../src/lib/errors.js";
import {
  findConfigFile,
  loadConfig,
  validateConfig,
} from "../src/lib/lint/config.js";
import { createTempDir, removeTempDir, writeFiles } from "./helpers.js";

describe("validateConfig", () => {
  it("accepts a full valid config", () => {
    const config = validateConfig(
      {
        include: ["src/**/*.ts"],
        exclude: ["dist"],
        match: "\\.ts$",
        format: "json",
        maxWarnings: 0,
        concurrency: 2,
        rules: {
          "regex-cow": { enabled: true, severity: "error", options: { n: 1 } },
        },
      },
      "test",
    );

    expect(config.rules?.["regex-cow"]?.severity).toBe("error");
  });

  it("rejects non-object configs", () => {
    expect(() => validateConfig([], "test")).toThrow(ConfigError);
  });

  it("rejects unknown options", () => {
    expect(() => validateConfig({ nope: true }, "test")).toThrow(/unknown option "nope"/);
  });

  it("rejects invalid values", () => {
    expect(() => validateConfig({ include: "src" }, "test")).toThrow(/array of strings/);
    expect(() => validateConfig({ format: "xml" }, "test")).toThrow(/pretty, json/);
    expect(() => validateConfig({ match: "(" }, "test")).toThrow(/regular expression/);
    expect(() => validateConfig({ maxWarnings: -1 }, "test")).toThrow(/greater than or equal/);
    expect(() => validateConfig({ concurrency: 0 }, "test")).toThrow(/greater than or equal/);
    expect(() => validateConfig({ rules: { r: { severity: "fatal" } } }, "test")).toThrow(
      /severity/,
    );
    expect(() => validateConfig({ rules: { r: { extra: 1 } } }, "test")).toThrow(
      /unknown option "extra"/,
    );
  });
});

describe("loadConfig", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createTempDir();
  });

  afterEach(async () => {
    await removeTempDir(dir);
  });

  it("returns an empty config when no file exists", async () => {
    expect(await loadConfig({ cwd: dir })).toEqual({ config: {} });
  });

  it("finds and loads a TypeScript config by walking up", async () => {
    await writeFiles(dir, {
      "flint.config.ts":
        'export default { rules: { "regex-cow": { severity: "error" } } };\n',
    });

    const fromRoot = await loadConfig({ cwd: dir });
    const fromNested = await loadConfig({ cwd: `${dir}/a/b` });

    expect(fromRoot.config.rules?.["regex-cow"]?.severity).toBe("error");
    expect(fromNested.path).toBe(fromRoot.path);
  });

  it("throws ConfigError for an explicit missing path", async () => {
    await expect(loadConfig({ cwd: dir, configPath: "nope.ts" })).rejects.toThrow(
      /config file not found/,
    );
  });

  it("throws ConfigError when the config file fails to load", async () => {
    await writeFiles(dir, { "flint.config.ts": 'throw new Error("bad config");\n' });

    await expect(loadConfig({ cwd: dir })).rejects.toThrow(/failed to load config/);
  });

  it("finds config files with other supported extensions", async () => {
    await writeFiles(dir, { "flint.config.mjs": "export default { format: 'json' };\n" });

    expect(await findConfigFile(dir)).toBe(`${dir}/flint.config.mjs`);
  });
});
