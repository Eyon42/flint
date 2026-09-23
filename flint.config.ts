import { defineConfig } from "flint/config";

export default defineConfig({
  include: ["src/**/*.ts", "tests/**/*.ts"],
  exclude: ["dist", "node_modules", ".flint-cache"],
  concurrency: 8,
  rules: {
    jev: {
      options: {
        cache: true,
        questions: {
          "no-sensitive-logging": {
            type: "noul",
            instructions:
              "The code logs or exposes sensitive data such as passwords, API keys, tokens, or PII",
            report: { min: 0.8, severity: "error" },
            locate: { lineMin: 0.3 },
          },
          "swallowed-error": {
            type: "noul",
            instructions:
              "The code silently ignores an unexpected error in a catch block instead of logging it, rethrowing it, or falling back to documented behavior",
            report: { min: 0.85, severity: "warning" },
            locate: { lineMin: 0.3 },
          },
          "spaghetti-code": {
            type: "noul",
            instructions:
              "The code has deeply nested or tangled control flow that is hard to follow",
            report: { min: 0.75, severity: "info" },
            locate: { lineMin: 0.3 },
          },
          "tautological-test": {
            type: "noul",
            instructions:
              "A test assertion is tautologically true and can never fail",
            report: { min: 0.85, severity: "warning" },
            locate: { lineMin: 0.3 },
          },
          "logic-error": {
            type: "noul",
            instructions:
              "The code has a logic error that produces a wrong result for some input: an off-by-one or boundary mistake, an inverted or wrong comparison or boolean condition, a loop that skips or double-processes an item, or a missing edge case such as empty, zero, negative, missing, or single-element input. Do not count style, naming, formatting, typing, or anything a linter or type checker reports. Only count when a concrete input produces the wrong behavior.",
            report: { min: 0.85, severity: "warning" },
            locate: { lineMin: 0.3 },
          },
          "concurrency-hazard": {
            type: "noul",
            instructions:
              "The code has a race, ordering, or interleaving hazard: concurrent tasks read or write shared mutable state without synchronization, a check-then-act sequence can interleave with another operation, work depends on an ordering that is not enforced, or cleanup happens before pending work finishes. Do not count deterministic sequential code. Only count when a concrete interleaving or ordering produces wrong behavior.",
            report: { min: 0.85, severity: "warning" },
            locate: { lineMin: 0.3 },
          },
          "unsafe-failure-path": {
            type: "noul",
            instructions:
              "The code can leave state or resources in a bad state when a step fails: a multi-step update is not atomic so a failure between steps leaves a partial write, a resource such as a file handle, connection, or lock is not released on an error path, or cleanup is skipped when an exception is thrown. Only count when a concrete failure produces a partial update or a leaked resource.",
            report: { min: 0.85, severity: "warning" },
            locate: { lineMin: 0.3 },
          },
          "security-logic": {
            type: "noul",
            instructions:
              "The code has a security logic flaw that is not a static pattern: a privileged operation is reachable without an authorization check, a user-controlled value reaches a sensitive sink such as a filesystem path, shell command, SQL query, or outbound URL without validation, or a security decision depends on data the caller can forge. Do not count hardcoded secrets or logging. Only count when a concrete input can exploit the flaw.",
            report: { min: 0.85, severity: "warning" },
            locate: { lineMin: 0.3 },
          },
        },
      },
    },
  },
});
