# flint

Pluggable linter with an engine built for AI-assisted analysis. Rules are short
prompts evaluated by [TypeSafe Jev](https://typesafe.ai) through the OpenRouter
Decisions API. Every rule of a file is batched into a single request, so adding
rules adds tokens but barely adds latency.

## Requirements

- Node.js >= 22
- pnpm
- `OPENROUTER_API_KEY` for AI analysis (see [Jev setup](#jev-setup))

## Setup

```sh
pnpm install
cp .env.example .env   # then set OPENROUTER_API_KEY
```

The CLI loads `.env` from the working directory when present; variables already
exported in the shell win.

## Usage

flint has three commands: `lint` (the default, so `flint` and `flint <patterns>`
lint), `find` (a one-off AI query), and `cache` (see below).

```sh
flint                             # lint the working directory (lint is the default command)
flint src tests                   # files, directories, and globs
flint "src/**/*.ts"
flint --git staged                # files staged in git
flint --git diff:main...HEAD      # files changed since a ref
flint --stdin < prompt.ts         # lint stdin
flint --format json | jq .summary
flint find "all uses of Promise.all"          # one-off query (see below)
flint find "hardcoded secrets" src tests      # query specific paths
flint cache clear                 # remove .flint-cache
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

An unrecognized command or a typo'd path is treated as a file pattern; when none
of the given patterns match a file, flint prints a notice and exits `0`. Run
`flint --help` for the command list and examples, or `flint find "<query>"` for a
one-off query.

### One-off queries with `find`

`flint find <query> [patterns...]` runs a query against the selected files
without editing `flint.config.ts`. The query becomes a single localized `jev`
question: configured `questions` are ignored, while the rest of the config
(`include`/`exclude`/`match`, model, cache, and request limits) still applies.

| Flag | Description |
| --- | --- |
| `--severity <severity>` | Severity of matches: `error`, `warning`, or `info` (default: `info`) |
| `--min <probability>` | Minimum file probability to report a match (default: `0.8`) |
| `--line-min <probability>` | Minimum line probability to report a match (default: `0.3`) |

The shared flags (`--git`, `--stdin`, `--stdin-filename`, `--config`, `--format`,
`--match`, `--max-warnings`, `--no-color`) behave exactly as in `lint`. Unlike
`lint`, `find` never reads or writes `.flint-cache`: every run queries Jev
afresh, even when `rules.jev.options.cache` is `true`. Matches default to
`info`, so `find` exits `0` when it finds something; use `--severity error` to
make matches fail the run. Pretty output uses match wording:

```
src/services/queue.ts
   4 │   const results = await Promise.all(tasks.map(run));
     │   info  all uses of Promise.all  find  0.91
   5 │   return results;

1 match (1 info)
```

### Exit codes

- `0` no issues (or warnings within `--max-warnings`); `find` matches unless
  escalated with `--severity`
- `1` errors, AI findings with `severity: "error"`, internal issues (for example a
  missing API key or a request failure), or too many warnings
- `2` usage or configuration error

## Configuration

Create a `flint.config.ts` in your project. It is discovered by walking up from
the working directory and loaded at runtime, so no build step is needed.

```ts
import { defineConfig } from "flint/config";

export default defineConfig({
  include: ["src/**/*.{ts,tsx}"],
  exclude: ["**/*.gen.ts"],
  match: "\\.tsx?$",
  format: "pretty",
  maxWarnings: 0,
  concurrency: 8,
  rules: {
    jev: {
      options: {
        questions: {
          "no-sensitive-logging": {
            type: "noul",
            instructions:
              "The code logs or exposes sensitive data such as passwords, API keys, tokens, or PII",
            report: { min: 0.8, severity: "error" },
            locate: true,
          },
        },
      },
    },
  },
});
```

CLI flags override the config file. Unknown options, unknown rules, and invalid
values are reported as configuration errors.

## Rules

| Rule | Default severity | Description |
| --- | --- | --- |
| `jev` | `warning` | AI analysis through the OpenRouter Decisions API |

`jev` is always in the registry. It is a no-op when no questions are configured,
and can be disabled with `{ enabled: false }` or have its severity overridden
with `{ severity: "error" }`.

### The `jev` rule

A question is a short prompt with a threshold. `noul` questions ask "is this
true?" and return a probability; a finding is reported when the probability is
at least `report.min` (default `0.8`). `choice` and `score` questions are also
supported for document-level checks.

```ts
questions: {
  "no-sensitive-logging": {
    type: "noul",
    instructions: "The code logs or exposes sensitive data",
    report: { min: 0.8, severity: "error", message: "logs sensitive data" },
    locate: true,
  },
  "tautological-test": {
    type: "noul",
    instructions: "A test assertion is tautologically true and can never fail",
    report: { min: 0.85 },
    locate: { chunkLines: 20, lineMin: 0.25, maxLines: 10 },
  },
  "spaghetti-code": {
    type: "noul",
    instructions: "The code has deeply nested or tangled control flow",
    report: { min: 0.7, severity: "info" },
  },
}
```

#### Localization

Without `locate`, a question reports one diagnostic covering the whole document.
With `locate`, flint runs a staged funnel per file:

1. **Classify and localize.** One request carries every question of the file
   plus a compact `#chunk` choice question per locating rule (section range and
   first line), asking Jev to pick the section exhibiting the issue.
2. **Refine.** One request per hit asks a `#line` choice question over the
   chosen section, sent as state with absolute line numbers. Every line whose
   probability clears `lineMin` (default `0.2`) is reported; if none does, flint
   tries adjacent sections, then falls back to the single most likely line.

Sections follow structural boundaries (blank lines and top-level declarations),
merge to at least `chunkLines` lines and at most `maxChunks` sections, and
overlap their neighbors by two lines. When a file plus its questions exceeds the
context budget, flint grows sections, batches questions across requests, and
finally splits the file at structural boundaries, classifying parts in parallel
and keeping the part with the highest `noul`. Files above `maxFileBytes` are
skipped with a notice; a single unsplittable line falls back to document-level
findings with a notice.

| Option | Default | Description |
| --- | --- | --- |
| `chunkLines` | `15` | Minimum lines per section |
| `maxChunks` | `12` | Maximum sections per file; neighbors merge to satisfy it |
| `lineMin` | `0.2` | Minimum line probability to report |
| `maxLines` | `20` | Cap reported lines per question per file |

#### Rule options

| Option | Description |
| --- | --- |
| `model` | Pin a Jev model (default: `OPENROUTER_DECISIONS_MODEL` or `~typesafe/jev-latest`) |
| `maxFileBytes` | Skip files above this size with a notice (default: `131072`) |
| `contextTokens` | Jev context window used for request budgeting (default: `32768`) |
| `reservedOutputTokens` | Tokens reserved for answers inside the window (default: `2048`) |
| `cache` | Cache answers under `.flint-cache/jev/` (default: `false`) |

Cache entries are keyed by a hash of the ruleset (model plus every question and
its report/locate options, including a prompt version) and the exact request
payload (state plus rendered criteria). Any change to either misses the cache;
refinement entries are reused while a section's numbered state and line criteria
stay identical. Bump `CACHE_VERSION` in `src/lib/lint/rules/jev-cache.ts` when
the funnel prompts change.

#### Jev setup

Put the key in a `.env` next to where you run flint (loaded automatically), or
export it in the shell:

```sh
OPENROUTER_API_KEY=sk-or-v1-...
# Optional: pin a version when tuning thresholds
OPENROUTER_DECISIONS_MODEL=typesafe/jev-1.13
```

Jev is not a chat model: it evaluates a `state` (the file's path, language, and
text) against typed questions and returns probabilities. Answers are
probabilities, so tune thresholds rather than treating an answer as certain.

#### Cost and performance

- Requests per file: one classify request plus one refine request per hit; parts
  and refines run in parallel under the client limiter.
- Classify sends the file text once plus compact section criteria; refine sends
  only the chosen section, so tokens no longer grow with the number of locating
  rules or `chunkLines`. Jev's context is 32K on OpenRouter; input is
  $0.042/M tokens and output is free. A conservative estimator (3 chars per
  token, 20% headroom) keeps every request under
  `contextTokens - reservedOutputTokens`.
- Files run in parallel (engine concurrency, default 8); in-flight Jev requests
  are capped at 4 and the run stops making network calls after 500 attempts.
- `flint lint --format json` reports `summary.ai` with request, token, and cost
  tallies.
- Knobs: `include`, per-question thresholds, `locate: false` for file-level
  rules, `chunkLines`, `maxChunks`, `lineMin`, `maxLines`, `maxFileBytes`,
  `contextTokens`, `reservedOutputTokens`, `concurrency`.

#### Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `OPENROUTER_API_KEY is not set` | Key missing while questions are configured | Export the key or disable `jev` |
| `Jev request failed with status 401` | Invalid or revoked key | Check the key in the OpenRouter dashboard |
| `Jev request budget exceeded` | More than 500 HTTP attempts in a run | Narrow `include` or raise per-question thresholds |
| File skipped notice | File above `maxFileBytes` | Raise `maxFileBytes` or narrow `include` |
| Localization skipped notice | A single line exceeds the context budget | Split the generated line; document-level findings still run |
| Too many findings | Threshold too low | Raise `report.min` / `lineMin` |

## Output

### Pretty (default)

AI findings render as code frames with red shades by score; context lines and
gutters are dimmed. Findings wider than 40 lines (for example document-level
hits) fall back to a single line.

```
src/services/auth.ts
  10 │   const session = await getSession(req);
  11 │   if (!session) return null;
  12 │   logger.info("session token: " + session.token);
     │   error  Jev "no-sensitive-logging": line 12 (p=0.91)  no-sensitive-logging  0.79
  13 │   return session;
  14 │ }
```

| Score | Shade |
| --- | --- |
| `>= 0.9` | bright red, bold |
| `0.8 – 0.9` | bright red |
| `0.7 – 0.8` | red, bold |
| `< 0.7` | red |

### JSON (`--format json`)

One diagnostic per located line. `ruleId` is the question id; `score` is
`noul × probability`; `data` carries the full breakdown.

```json
{
  "ruleId": "no-sensitive-logging",
  "severity": "error",
  "message": "logs sensitive data",
  "path": "src/auth.ts",
  "range": { "line": 12, "column": 1, "endLine": 12, "endColumn": 47 },
  "score": 0.79,
  "data": {
    "questionId": "no-sensitive-logging",
    "stage": "line",
    "noul": 0.87,
    "chunk": { "key": "1", "lines": [1, 15], "probability": 0.91 },
    "lineProbability": 0.91,
    "confidence": 0.94,
    "model": "typesafe/jev-1.13"
  }
}
```

## Architecture

```
Source → Target → Selection → Content → Document → Engine × Rule → Diagnostic → Formatters
```

- `src/lib/lint/sources/` — file, directory, glob, git, and stdin target sources
- `src/lib/lint/selection.ts` — dedupe, ignore rules (`.gitignore` plus defaults), match filter, binary and size gates
- `src/lib/lint/content/` — content providers (disk, in-memory) keyed by target
- `src/lib/lint/rules/` — rule contract, registry, `jev` rule, chunking, and funnel
- `src/lib/ai/jev.ts` — Jev client: shared per model, concurrency limiter, request budget, usage stats
- `src/lib/lint/engine.ts` — runs rules over documents with bounded concurrency and per-rule failure isolation
- `src/lib/lint/diagnostics.ts` — canonical diagnostic model, ordering, dedupe, severity counts
- `src/lib/lint/formatters/` — pure renderers (`pretty`, `json`)
- `src/lib/lint/reporter.ts` — output stream, TTY/color decisions, exit code

## Development

```sh
pnpm dev lint .   # run from source
pnpm lint         # static linting with oxlint (see .oxlintrc.json)
pnpm lint:ai      # lint this repo with flint (dogfooding, see flint.config.ts)
pnpm typecheck
pnpm test
pnpm build        # bundle to dist/ (ESM + declarations)
```

Common static rules (unused code, non-null assertions, suspicious patterns) are
left to oxlint; the flint config focuses on prompt-defined semantic checks.
`pnpm dev` and `pnpm lint:ai` run the CLI from source, which loads `.env` from
the working directory, so `pnpm lint:ai` works after `cp .env.example .env`.

## Roadmap

- Cross-file and repo-level analysis
- Multiple ranked sections per rule with per-chunk refinement
- SARIF/GitHub annotations for located findings
- Inline suppression comments and baselines
