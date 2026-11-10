# Design note: ts-api-harness

## 1. Architecture

```
task.yaml ─► prepareWorkspace (scaffold | copy source) ─► contract snapshot (brownfield)
                                   │
   ┌───────────────────────────────▼───────────────────────────────────────┐
   │ loop (src/core/loop.ts)                                               │
   │   Driver.complete(system, compacted history, tool specs)              │
   │   for each tool call:                                                 │
   │     zod-validate args ─► PRE hooks (block | record | pass)            │
   │       path-guard · secret-scan · observed-red · escape-hatches        │
   │     ─► tool.run ─► POST hooks (typecheck-on-write)                    │
   │     ─► compact result to model, raw output to runs/<id>/logs          │
   │   finish ─► gates: all tests (harness runner) · observed-red audit ·  │
   │             standards check 100% (static + runtime + contract drift)  │
   │   ends only when gates are green (or turn limit, reported NOT GREEN)  │
   └───────────────────────────────┬───────────────────────────────────────┘
                                   ▼
          tokens/<id>.json · runs/<id>/report.md · check.txt ─► ship (optional)
```

**Deterministic (code):** workspace scaffold and copy, test runs and the red/green ledger, tsc, every standards check, the contract snapshot and diff, hook decisions, the finish verdict, git, push and the PR.
**Model decides:** task breakdown, which context to fetch, test design, and code.

The model has no shell and no git. It can only *ask* the harness to run tests (`run_tests`) or checks (`run_checks`), and gets back pass/fail lines. The ledger is updated only from vitest's JSON report, so "observed red" never rests on the model's word.

## 2. Driver abstraction

`src/core/types.ts`:

```ts
interface Driver {
  label: string; model: string;
  complete(req: { system; messages: Message[]; tools: ToolSpec[]; maxOutputTokens }): Promise<{ text; toolCalls; usage; stop }>;
  countTokens(req): Promise<{ tokens; method }>;
}
```

`Message` is neutral (`user`, `assistant` with `toolCalls`, `tool` with `results`). `ToolSpec.parameters` is plain JSON Schema generated from each tool's Zod schema.

**Kept out of the interface:**

- vendor message shapes (`tool_use`/`tool_result` blocks, `tool_calls`/`role: tool`)
- vendor tool envelopes (`input_schema` vs `{type: function}`)
- role-alternation rules, stop-reason names, cache-token accounting
- model ids

All of these live only in `src/drivers/claude.ts` and `src/drivers/openai.ts`. Model ids come from `--model` or the environment, never from the task file. The task schema is a `strictObject`, so a task file that names a model is rejected. `tests/unit/agnostic.test.ts` greps `src/core`, `src/hooks`, `src/checks`, `src/registry` and `tasks/` for provider names and vendor schema keys, and fails on any hit.

## 3. Token budget

**Baseline definition:** same task, same driver, context fetchers and compaction disabled. That means:

- the whole workspace and the full standards document are front-loaded into the system prompt
- tools return raw output (full files, full vitest and check output)
- no history compaction

**Measured, two ways, both written by the harness to `tokens/<run>.json`:**

- **Shadow baseline (every JIT run).** Each turn, the harness counts what the baseline request would be on the same trajectory: front-loaded system prompt plus the raw, uncompacted history. It uses `driver.countTokens`, which is the provider count endpoint for Claude and a local o200k estimate for OpenAI and replay; the method is labelled in the report. Actual input tokens come from the provider's `usage`.
- **Measured baseline run (`--baseline`).** The real run with fetchers off. On the replay greenfield task it measured 89,997 input tokens against a shadow of 89,957, which validates the shadow method.

**Mechanisms that earn the reduction:**

1. **JIT fetchers.** Nothing from the repo is in the prompt at start. Context comes from `api_map` (routes, source to tests map, helper exports), `outline`, `read_file` with line ranges (max 200 lines), `search` (max 30 hits) and `read_standard(id)`.
2. **Compact returns.** Tests and checks return pass/fail lines; raw logs go to disk and are referenced by path.
3. **Compaction with a pinned working set.** Executed write arguments (full file bodies) shrink to a size marker. Each tool declares a `contextKey`, and the latest read per key stays verbatim until a write to that path makes it stale, capped at 32k chars. Every other result older than the last exchange shrinks to one line.
4. **Stall detector.** After 6 read-only turns, the loop tells the model its reads are still pinned and that the next step is to write the test.
5. **Cheapest mechanism.** Rules are hooks and checks, so they cost zero tokens until they fire. The system prompt is 13 lines (~350 tokens).

**Lesson from the first real run.** The first version compacted by recency alone: only the last exchange stayed verbatim. Claude read four scaffold files per turn, the next turn compacted them, and it re-read them for 40 turns (NOT GREEN). The replay driver could not reveal this, because a script never re-reads. Pinning the working set fixed it: the next run was GREEN in 11 turns.

**Measured (real models through OpenRouter; baseline and actual both counted with the same local tokenizer):**

| Task | Driver | Turns | Reduction |
|---|---|---|---|
| greenfield | claude | 14 | 63.2% |
| greenfield | openai | 18 | 53.6% |
| brownfield | claude | 6 | 78.8% |
| brownfield | openai | 19 | 73.4% |

**The >90% target is not met.** The workspaces are small (front-loaded baseline ≈ 5–7k tokens), and the model genuinely needs most of the scaffold, so the pinned working set dominates actual usage. A tighter pin budget cuts tokens but brings back re-reads, a trade-off that is visible in the data. The ratio should rise with the size of the official sample repo; that needs measuring once it is provided.

## 4. Extension points

`src/core/registry.ts` imports every `*.ts` under `src/registry/{tools,validators,linters,hooks}` on each run.

- **Tools** go to the model with their Zod schema converted to JSON Schema.
- **Validators and linters** are `RuleDef`s. They receive the same `RuleContext` as the built-in rules: ts-morph project, source and test files, extracted routes, and an exec helper. Each gets its own pass/fail line with locations in `harness check`.
- **Hooks** run after the built-ins.

`tests/unit/registry.test.ts` drops in a tool and a linter, then asserts both appear with no core change.

**Core directory:** `src/core/`. `src/drivers`, `src/hooks` and `src/checks` are also never edited to extend.

## 5. Honesty boundary

**Proven by the harness on every run** (re-run at the end, and again by `ship`):

- every test passes under the harness runner
- every source file written in the run has a covering test the runner saw fail
- the static standards (Zod boundaries, inferred types, problem+json paths, no escape hatches, REST conventions) hold
- `tsc --strict --noUncheckedIndexedAccess` is clean
- real error responses are well-formed problem+json (runtime probes)
- the pre-change contract is not broken (brownfield)

**UNPROVEN, never green:**

- runtime probes when the API cannot boot or `--no-runtime` is used
- a contract snapshot that cannot be resolved
- push or PR when there is no remote or no `gh` CLI
- a run that hits the turn limit

**Not applicable, reported as n/a and not counted:**

- contract drift on greenfield runs
- ORM validators when there are no ORM queries

**Out of reach; a human must verify:**

- business semantics beyond the listed behaviours
- whether tests assert the right things (the gate proves they went red, then green, not that they are meaningful)
- persistence (stores are in-memory), authn/authz, performance
- static analysis recognises the Express + Zod patterns documented in `docs/standards.md`. Other styles (validation middleware, mounted sub-routers with dynamic paths) fail closed and may need a new rule plugin.
