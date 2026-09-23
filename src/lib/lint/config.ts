import { access } from "node:fs/promises";
import path from "node:path";
import { createJiti } from "jiti";
import { ConfigError } from "../errors.js";
import type { Severity } from "./types.js";

export interface RuleSetting {
  enabled?: boolean;
  severity?: Severity;
  options?: unknown;
}

export interface LintConfig {
  include?: string[];
  exclude?: string[];
  match?: string;
  format?: "pretty" | "json";
  maxWarnings?: number;
  concurrency?: number;
  rules?: Record<string, RuleSetting>;
}

export function defineConfig(config: LintConfig): LintConfig {
  return config;
}

const CONFIG_FILENAMES = [
  "flint.config.ts",
  "flint.config.mts",
  "flint.config.js",
  "flint.config.mjs",
];

const FORMAT_NAMES = new Set(["pretty", "json"]);
const SEVERITIES = new Set(["error", "warning", "info"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function findConfigFile(
  cwd: string,
): Promise<string | undefined> {
  let directory = path.resolve(cwd);
  while (true) {
    for (const name of CONFIG_FILENAMES) {
      const candidate = path.join(directory, name);
      if (await fileExists(candidate)) {
        return candidate;
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      return undefined;
    }
    directory = parent;
  }
}

export interface LoadConfigOptions {
  cwd: string;
  configPath?: string;
}

export interface LoadedConfig {
  config: LintConfig;
  path?: string;
}

export async function loadConfig(
  options: LoadConfigOptions,
): Promise<LoadedConfig> {
  const filePath = options.configPath
    ? path.resolve(options.cwd, options.configPath)
    : await findConfigFile(options.cwd);

  if (!filePath) {
    return { config: {} };
  }
  if (!(await fileExists(filePath))) {
    throw new ConfigError(`config file not found: ${filePath}`);
  }

  const jiti = createJiti(import.meta.url);
  let loaded: unknown;
  try {
    loaded = await jiti.import(filePath);
  } catch (error) {
    throw new ConfigError(
      `failed to load config ${filePath}: ${messageFrom(error)}`,
    );
  }

  const value =
    isPlainObject(loaded) && "default" in loaded ? loaded.default : loaded;
  return { config: validateConfig(value, filePath), path: filePath };
}

function validateStringArray(
  value: unknown,
  key: string,
  source: string,
): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new ConfigError(`${source}: "${key}" must be an array of strings`);
  }
  return [...value] as string[];
}

function validateNumber(
  value: unknown,
  key: string,
  source: string,
  minimum: number,
): number {
  if (!Number.isInteger(value) || (value as number) < minimum) {
    throw new ConfigError(
      `${source}: "${key}" must be an integer greater than or equal to ${minimum}`,
    );
  }
  return value as number;
}

function validateRules(
  value: unknown,
  source: string,
): Record<string, RuleSetting> {
  if (!isPlainObject(value)) {
    throw new ConfigError(`${source}: "rules" must be an object`);
  }

  const rules: Record<string, RuleSetting> = {};
  for (const [id, setting] of Object.entries(value)) {
    if (!isPlainObject(setting)) {
      throw new ConfigError(`${source}: rule "${id}" must be an object`);
    }

    const rule: RuleSetting = {};
    for (const [key, optionValue] of Object.entries(setting)) {
      switch (key) {
        case "enabled":
          if (typeof optionValue !== "boolean") {
            throw new ConfigError(
              `${source}: rule "${id}" option "enabled" must be a boolean`,
            );
          }
          rule.enabled = optionValue;
          break;
        case "severity":
          if (typeof optionValue !== "string" || !SEVERITIES.has(optionValue)) {
            throw new ConfigError(
              `${source}: rule "${id}" option "severity" must be one of error, warning, info`,
            );
          }
          rule.severity = optionValue as Severity;
          break;
        case "options":
          rule.options = optionValue;
          break;
        default:
          throw new ConfigError(
            `${source}: unknown option "${key}" for rule "${id}"`,
          );
      }
    }
    rules[id] = rule;
  }
  return rules;
}

export function validateConfig(value: unknown, source: string): LintConfig {
  if (!isPlainObject(value)) {
    throw new ConfigError(`${source}: config must export an object`);
  }

  const config: LintConfig = {};
  for (const [key, entry] of Object.entries(value)) {
    switch (key) {
      case "include":
        config.include = validateStringArray(entry, key, source);
        break;
      case "exclude":
        config.exclude = validateStringArray(entry, key, source);
        break;
      case "match": {
        if (typeof entry !== "string") {
          throw new ConfigError(`${source}: "match" must be a string`);
        }
        try {
          RegExp(entry);
        } catch {
          throw new ConfigError(`${source}: "match" must be a valid regular expression`);
        }
        config.match = entry;
        break;
      }
      case "format": {
        if (typeof entry !== "string" || !FORMAT_NAMES.has(entry)) {
          throw new ConfigError(`${source}: "format" must be one of pretty, json`);
        }
        config.format = entry as "pretty" | "json";
        break;
      }
      case "maxWarnings":
        config.maxWarnings = validateNumber(entry, key, source, 0);
        break;
      case "concurrency":
        config.concurrency = validateNumber(entry, key, source, 1);
        break;
      case "rules":
        config.rules = validateRules(entry, source);
        break;
      default:
        throw new ConfigError(`${source}: unknown option "${key}"`);
    }
  }

  return config;
}
