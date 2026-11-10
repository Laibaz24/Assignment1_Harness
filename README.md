# ts-api-harness

An agent **harness** (not an agent) that governs TypeScript REST API work: greenfield APIs from a task file, brownfield changes to an existing API, on Claude or OpenAI with the same task file, hooks and checks. Design note: [docs/design.md](docs/design.md).

## One-command setup

```bash
npm run setup          # npm install + harness typecheck + unit tests
```

Node >= 20.12. Provider keys come from the environment only (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`), or from a git-ignored `.env` (see `.env.example`). Nothing secret is committed.

## Commands

```bash
# Same task file, two providers. No edits to tasks/, src/hooks or src/checks between runs.
node bin/harness.mjs run --task tasks/users-api.yaml --driver claude
node bin/harness.mjs run --task tasks/users-api.yaml --driver openai

# Brownfield change to the sample existing API
node bin/harness.mjs run --task tasks/sample-api-change.yaml --driver claude

# Standards check (exit 0 only at 100%)
node bin/harness.mjs check --api ./generated/users-api

# Token baseline run (context fetchers + compaction disabled)
node bin/harness.mjs run --task tasks/users-api.yaml --driver claude --baseline

# Harness-owned shipping: re-runs every gate, then branch -> commit -> push -> PR
node bin/harness.mjs ship --run <runId> --base main      # or add --ship to `run`

# Offline end-to-end (scripted replay driver, no keys needed)
npm run demo:greenfield && npm run demo:brownfield

node bin/harness.mjs registry   # list discovered plugins
```

`npm link` (or `npx harness`) exposes the same CLI as `harness ...`.

## Core directory (must stay untouched by extensions)

**`src/core/`** is the engine: loop, registry loader, runner, gates, reports, ship step, CLI. `src/drivers/`, `src/hooks/` and `src/checks/` are also never edited to extend the harness. **All extensions go in `src/registry/`.**

| Extension | Drop one file into | Export |
|---|---|---|
| Tool (e.g. `openapi-diff`) | `src/registry/tools/` | `defineTool({ name, description, kind, schema, run })` |
| ORM validator | `src/registry/validators/` | `defineValidator({ id, description, run(ctx) })` |
| Linter rule | `src/registry/linters/` | `defineLinter({ id, description, run(ctx) })` |
| Hook | `src/registry/hooks/` | `defineHook({ name, phase, appliesTo, run })` |

Files are discovered on every run, so `git diff --stat` after an addition shows only the new plugin file. Shipped examples: `tools/contract-status.ts`, `validators/orm-explicit-select.ts` (Prisma/Drizzle explicit columns on users), `linters/no-console.ts`. See [src/registry/README.md](src/registry/README.md).

## What is enforced, and where

| Guarantee | Mechanism | File |
|---|---|---|
| Zod at every boundary | check `zod-boundary`, `zod-infer` | `src/checks/rules/` |
| RFC 7807 only | check `problem-json` (static) + `problem-json:runtime` (boots the API, fires error requests) | `src/checks/rules/` |
| Strict types | check `tsc --strict` (flags forced on the CLI) + `strict-types`; hook `escape-hatches` blocks `any`, `!` and `@ts-ignore` before they reach disk | `src/checks/rules/`, `src/hooks/` |
| REST conventions | check `rest-conventions` | `src/checks/rules/` |
| Observed red before source edits | hook `observed-red` + finish gate audit; ledger written only from the harness's own vitest JSON report | `src/hooks/observed-red.ts`, `src/core/runner.ts` |
| Hooks, not prompts | pre-hooks `path-guard`, `secret-scan`, `observed-red`, `escape-hatches`; post-hook `typecheck-on-write` | `src/hooks/` |
| Harness ships, agent never does | the model has no shell or git tool; `ship` re-runs gates, refuses protected branches, never force-pushes | `src/core/ship.ts` |
| Honesty boundary | skipped = `UNPROVEN` (never green); every run writes proven / failed / UNPROVEN / n/a | `src/core/report.ts` |

## Our own addition: the contract-drift gate

sf-harness has no contract gate. Before a brownfield run, the harness derives the API contract **from code**: routes and success statuses from the AST, and request and response shapes from the Zod schemas each handler actually parses with (converted to JSON Schema). At finish it re-derives the contract and diffs it. Breaking changes fail the run unless the task file lists them under `allowBreaking`. Breaking changes are removed routes or fields, changed types or statuses, new required request fields, tightened constraints and narrowed enums. Additive changes pass and are listed. Files: `src/checks/contract.ts`, `src/checks/rules/contract-drift.ts`. Standalone: `harness contract --api <dir> --out before.json`, then `harness check --api <dir> --contract before.json`.

## Run evidence (in this repo)

| What | Where |
|---|---|
| Driver logs (transcript, console, raw tool logs) | `runs/<runId>/transcript.jsonl`, `console.log`, `logs/` |
| Token reports | `tokens/<runId>.json` |
| Standards check output | `runs/<runId>/check.txt` |
| Run report + honesty boundary | `runs/<runId>/report.md` |
| PR opened by the harness | `runs/<runId>/ship.json` |

**Status of the evidence currently committed.** Read this before trusting any number.

**Real-model runs.** Both drivers were routed through OpenRouter using `OPENROUTER_API_KEY`: the Claude driver with the Anthropic Messages format and `anthropic/claude-sonnet-5.5`, the OpenAI driver with the Chat Completions format and `openai/gpt-5.5`. The task files, hooks and checks were identical across all runs.

| Task | Driver | Turns | Verdict | Standards | Baseline -> actual input tokens | Reduction |
|---|---|---|---|---|---|---|
| users-api (greenfield) | claude | 14 | GREEN | 100% | 180,565 -> 66,452 | 63.2% |
| users-api (greenfield) | openai | 18 | GREEN | 100% | 259,420 -> 120,389 | 53.6% |
| sample-api-change (brownfield) | claude | 6 | GREEN | 100% | 67,318 -> 14,275 | 78.8% |
| sample-api-change (brownfield) | openai | 19 | GREEN | 100% | 291,312 -> 77,613 | 73.4% |

- **Gates fired on real models.** In the Claude greenfield run, `observed-red` blocked edits to `src/app.ts` until the model added `// @covers src/app.ts` to its test and saw it fail. Both brownfield runs observed a red test before changing products, and the contract-drift gate passed 8/8 routes, with additive changes only.
- **Token target missed: 54–79%, not >90%.** Both sides are counted with the same method (a local o200k tokenizer, because OpenRouter has no token-count endpoint). The provider-billed figure is kept separately as `providerReportedInputTokens`. The cause is small workspaces: the front-loaded baseline is only ~5–7k tokens, and the model legitimately needs most of the scaffold, so the pinned working set (≤ 8k tokens) dominates actual usage. Larger repos and longer runs widen the gap.
- **First real run failed, and that shaped the design.** `runs/users-api-claude-2026-11-10T06-41-52` ended NOT GREEN after 40 turns. Recency-only compaction made the model re-read the same files forever. The fix was a pinned working set plus a stall detector (see docs/design.md).
- **Replay runs (offline, scripted)** remain as deterministic CI evidence. The measured `--baseline` run (89,997 tokens) matches the shadow baseline (89,957), which validates the shadow method.
- **Pull request:** the real-model evidence (`generated/`, `runs/`, `tokens/`) is delivered as a PR against `main`.
- **Placeholder inputs:** `tasks/*.yaml` and `tests/fixtures/sample-api` stand in for the official task file and sample repo. To switch, point a task's `source` at the provided repo. No harness code changes.

## Team

- _Name_: _what they built_ (fill in)
