#!/usr/bin/env node
import { CommanderError } from "commander";
import { createProgram, type CliState } from "./cli.js";
import { loadDotEnv } from "./lib/env.js";
import { ConfigError, UsageError } from "./lib/errors.js";

async function main(): Promise<number> {
  const state: CliState = { exitCode: 0 };
  loadDotEnv(process.cwd());

  try {
    await createProgram(state).parseAsync(process.argv);
    return state.exitCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode === 0 ? 0 : 2;
    }
    if (error instanceof UsageError || error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

main().then((code) => {
  process.exitCode = code;
});
