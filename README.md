# flint

Pluggable linter with an engine built for AI-assisted analysis. Rules are the
extension point: the built-in `regex-cow` rule is a placeholder, and AI-backed
rules will register through the same contract.

## Requirements

- Node.js >= 22
- pnpm

## Setup

```sh
pnpm install
```

## Usage

```sh
flint lint                        # lint the working directory
flint lint src tests              # files, directories, and globs
flint lint "src/**/*.ts"
flint lint --git staged           # files staged in git
flint lint --git diff:main...HEAD # files changed since a ref
flint lint --stdin < prompt.ts    # lint stdin
flint lint --format json | jq .summary
```

| Flag | Description |
| --- | --- |
| `-c, --config <path>` | Path to a config file (default: nearest `flint.config.*`) |
| `--git <mode>` | `staged`, `working`, or `diff:<ref>` (content always comes from the worktree) |
| `--stdin` | Lint content from stdin |
| `--stdin-filename <path>` | Path to report for `--stdin` input (default: `<stdin>`) |
| `--format <format>` | `pretty` (default) or `json` |
| `--match <regex>` | Only lint files whose path matches this regex |
| `--max-warnings <n>` | Exit with code 1 when warnings exceed `n` |
| `--no-color` | Disable colored output |

### Exit codes

- `0` no issues (or warnings within `--max-warnings`)
- `1` errors, internal issues (for example a rule that crashed), or too many warnings
- `2` usage or configuration error

## Configuration

Create a `flint.config.ts` in your project. It is discovered by walking up from
the working directory and loaded at runtime, so no build step is needed.

```ts
import { defineConfig } from "flint/config";

export default defineConfig({
  include: ["src/**/*.ts"],
  exclude: ["**/*.gen.ts"],
  match: "\\.ts$",
  format: "pretty",
  maxWarnings: 0,
  concurrency: 8,
  rules: {
    "regex-cow": { severity: "error" },
  },
});
```

CLI flags override the config file. Unknown options, unknown rules, and invalid
values are reported as configuration errors.

## Rules

| Rule | Default severity | Description |
| --- | --- | --- |
| `regex-cow` | `warning` | Placeholder rule that reports every whole-word occurrence of "cow" |

Rules can be disabled with `{ enabled: false }` or have their severity
overridden with `{ severity: "error" }`.

## Architecture

```
Source → Target → Selection → Content → Document → Engine × Rule → Diagnostic → Formatters
```

- `src/lib/lint/sources/` — file, directory, glob, git, and stdin target sources
- `src/lib/lint/selection.ts` — dedupe, ignore rules (`.gitignore` plus defaults), match filter, binary and size gates
- `src/lib/lint/content/` — content providers (disk, in-memory) keyed by target
- `src/lib/lint/rules/` — rule contract, registry, built-in rules
- `src/lib/lint/engine.ts` — runs rules over documents with bounded concurrency and per-rule failure isolation
- `src/lib/lint/diagnostics.ts` — canonical diagnostic model, ordering, dedupe, severity counts
- `src/lib/lint/formatters/` — pure renderers (`pretty`, `json`)
- `src/lib/lint/reporter.ts` — output stream, TTY/color decisions, exit code

## Development

```sh
pnpm dev lint .   # run from source
pnpm typecheck
pnpm test
pnpm build        # bundle to dist/ (ESM + declarations)
```

## Roadmap

- AI-backed rules (the `Rule` contract is the seam)
- Revision-aware git content (lint the index blob instead of the worktree)
- Additional formatters (sarif, GitHub annotations)
- Inline suppression comments and baselines
