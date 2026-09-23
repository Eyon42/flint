import type { JevRuleQuestion } from "../jev.js";

export const qualityQuestions = {
  "logic-error": {
    type: "noul",
    instructions:
      "The code has a logic error that produces a wrong result for some input: an off-by-one or boundary mistake, an inverted or wrong comparison or boolean condition, a loop that skips or double-processes an item, or a missing edge case such as empty, zero, negative, missing, or single-element input. Do not count style, naming, formatting, typing, or anything a linter or type checker reports. Only count when a concrete input produces the wrong behavior.",
    criteria: {
      true: "a concrete input exists for which the code returns or produces the wrong result",
      false:
        "for every input the code produces the intended result, or the issue is only style, naming, typing, or a static pattern a linter would catch",
    },
    report: { min: 0.85, severity: "warning", message: "logic error" },
    locate: { lineMin: 0.3 },
  },
  "swallowed-error": {
    type: "noul",
    instructions:
      "The code silently ignores an unexpected error in a catch block instead of logging it, rethrowing it, or falling back to documented behavior",
    criteria: {
      true: "an unexpected error is caught and discarded without logging, rethrowing, or a documented fallback",
      false:
        "the catch logs, rethrows, or handles the error deliberately, or the ignored failure is an expected, documented case",
    },
    report: { min: 0.85, severity: "warning", message: "swallowed error" },
    locate: { lineMin: 0.3 },
  },
  "unsafe-failure-path": {
    type: "noul",
    instructions:
      "The code can leave state or resources in a bad state when a step fails: a multi-step update is not atomic so a failure between steps leaves a partial write, a resource such as a file handle, connection, or lock is not released on an error path, or cleanup is skipped when an exception is thrown. Only count when a concrete failure produces a partial update or a leaked resource.",
    criteria: {
      true: "a concrete failure between steps leaves a partial update, a leaked resource, or unreleased cleanup",
      false:
        "failures leave state and resources consistent, or the operation is atomic or rolled back",
    },
    report: {
      min: 0.85,
      severity: "warning",
      message: "unsafe failure path",
    },
    locate: { lineMin: 0.3 },
  },
  "concurrency-hazard": {
    type: "noul",
    instructions:
      "The code has a race, ordering, or interleaving hazard: concurrent tasks read or write shared mutable state without synchronization, a check-then-act sequence can interleave with another operation, work depends on an ordering that is not enforced, or cleanup happens before pending work finishes. Do not count deterministic sequential code. Only count when a concrete interleaving or ordering produces wrong behavior.",
    criteria: {
      true: "a concrete interleaving or ordering of concurrent operations produces wrong behavior",
      false:
        "the code is sequential, or shared state is synchronized or ordered so no interleaving produces wrong behavior",
    },
    report: {
      min: 0.85,
      severity: "warning",
      message: "concurrency hazard",
    },
    locate: { lineMin: 0.3 },
  },
  "missing-await": {
    type: "noul",
    instructions:
      "An asynchronous call's promise is not awaited, or is awaited in the wrong place, so work that must complete or must be observed does not: a floating promise whose rejection is lost, a missing await that makes a later step run before the previous one finishes, or a loop that starts async work without sequencing it. Do not count intentionally detached fire-and-forget work that handles its own errors. Only count when a concrete execution loses an error or runs an effect out of order.",
    criteria: {
      true: "a concrete execution loses an error or runs a dependent step before the async work finishes because an await is missing or misplaced",
      false:
        "every async call whose result or failure matters is awaited or explicitly handled, or detached work cannot affect the result",
    },
    report: { min: 0.85, severity: "warning", message: "missing await" },
    locate: { lineMin: 0.3 },
  },
  "unreachable-code": {
    type: "noul",
    instructions:
      "Code can never execute or a branch can never be taken: statements after return, throw, break, or continue, a condition that is impossible given the surrounding checks and types, or a guard for a case an earlier guard already handled. Do not count code guarded by a feature flag, environment check, or other value that varies at runtime. Only count when no execution can reach the code.",
    criteria: {
      true: "no execution path can reach the code or take the branch",
      false:
        "the code is reachable in some execution, or its reachability depends on a runtime value such as a flag or environment",
    },
    report: { min: 0.85, severity: "warning", message: "unreachable code" },
    locate: { lineMin: 0.3 },
  },
  "inconsistent-state": {
    type: "noul",
    instructions:
      "Related pieces of state that must agree can drift apart: two fields updated in some paths but not others, a derived value cached separately from its source and not refreshed when the source changes, or a flag that no longer matches the data it describes. Do not count state that is intentionally independent. Only count when a concrete sequence of operations leaves values that must agree inconsistent.",
    criteria: {
      true: "a concrete sequence of operations leaves values that must agree inconsistent",
      false:
        "all paths update related state together, or the values are intentionally independent",
    },
    report: { min: 0.85, severity: "warning", message: "inconsistent state" },
    locate: { lineMin: 0.3 },
  },
  "duplicated-logic": {
    type: "noul",
    instructions:
      "The same non-trivial logic is implemented in more than one place, so a future fix or rule change in one copy will not apply to the others. Look for repeated validation, repeated calculations, or near-identical branches with small unexplained differences. Do not count trivial one-line expressions or idiomatic repetition. Only count when the copies implement the same rule or calculation and can drift apart.",
    criteria: {
      true: "two or more copies implement the same rule or calculation, and a change to one would leave the others inconsistent",
      false:
        "the similarity is trivial or idiomatic, or the copies intentionally implement different rules",
    },
    report: { min: 0.8, severity: "warning", message: "duplicated logic" },
    locate: { lineMin: 0.3 },
  },
  "tautological-test": {
    type: "noul",
    instructions:
      "A test assertion is tautologically true and can never fail: it compares a value with itself, asserts on a value it just constructed, depends on a mock that always returns the asserted value, or restates the implementation instead of checking its result. Do not count tests that assert a real property even if it holds today. Only count when no plausible implementation of the code under test could fail the assertion.",
    criteria: {
      true: "no plausible implementation of the code under test could fail the assertion",
      false:
        "the assertion checks a real property that a wrong implementation would violate",
    },
    report: { min: 0.85, severity: "warning", message: "tautological test" },
    locate: { lineMin: 0.3 },
  },
  "conditional-test": {
    type: "noul",
    instructions:
      "A test can silently pass without checking anything: assertions inside an if, loop, or try/catch that may never run, a test body that returns early, or a test with no assertion at all. Do not count conditional assertions that the test requires and that fail loudly when the condition is missing. Only count when the test reports success without evaluating its assertions.",
    criteria: {
      true: "a concrete execution reaches the end of the test without evaluating any assertion",
      false:
        "the test always evaluates its assertions, or skips explicitly in a way the test runner reports as skipped",
    },
    report: { min: 0.85, severity: "warning", message: "conditional test" },
    locate: { lineMin: 0.3 },
  },
  "stale-comment": {
    type: "noul",
    instructions:
      "A comment or docstring contradicts the code it describes: it names a different value, condition, or behavior than the implementation, documents parameters or results that no longer exist, or claims an invariant the code does not maintain. Do not count comments that are merely incomplete or stylistic. Only count when the comment states something a reader would rely on and the code does the opposite.",
    criteria: {
      true: "the comment states a fact about the code that the code contradicts",
      false:
        "the comment matches the code, or is merely incomplete or stylistic",
    },
    report: { min: 0.8, severity: "info", message: "stale comment" },
    locate: { lineMin: 0.3 },
  },
  "spaghetti-code": {
    type: "noul",
    instructions:
      "The code has deeply nested or tangled control flow that is hard to follow",
    criteria: {
      true: "nested or interleaved control flow obscures what the code does",
      false: "the control flow is straightforward even if the code is long",
    },
    report: { min: 0.75, severity: "info", message: "spaghetti code" },
    locate: { lineMin: 0.3 },
  },
} satisfies Record<string, JevRuleQuestion>;
