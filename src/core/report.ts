/**
 * Reports written by the harness on every run ("measured, not claimed"):
 *   tokens/<runId>.json   baseline vs actual input tokens per turn
 *   runs/<runId>/report.{json,md}, check.txt   gates, honesty boundary, standards output
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GateResult } from './gates.ts';
import { HARNESS_ROOT } from './registry.ts';
import type { Driver, RunState } from './types.ts';
import { relPosix } from './workspace.ts';

export interface TurnTokens {
  turn: number;
  baselineInputTokens: number;
  actualInputTokens: number;
  /** What the provider billed as input (own tokenizer + hidden tool prompt); not used for the ratio. */
  providerReportedInputTokens: number;
  outputTokens: number;
  costUsd: number;
  tools: string[];
}

const pct = (base: number, actual: number): number => (base <= 0 ? 0 : Math.round((1 - actual / base) * 1000) / 10);

export function writeTokenReport(a: { runId: string; task: string; driver: Driver; baseline: boolean; baselineMethod: string; turns: TurnTokens[] }): string {
  const dir = join(HARNESS_ROOT, 'tokens');
  mkdirSync(dir, { recursive: true });
  const baseTotal = a.turns.reduce((s, t) => s + t.baselineInputTokens, 0);
  const actualTotal = a.turns.reduce((s, t) => s + t.actualInputTokens, 0);
  const report = {
    runId: a.runId,
    task: a.task,
    driver: a.driver.label,
    model: a.driver.model,
    mode: a.baseline ? 'baseline' : 'jit',
    baseline: {
      definition: 'Same task, same driver, context fetchers and compaction disabled: whole workspace + full standards document front-loaded into the system prompt, raw tool output, no history compaction.',
      method: a.baselineMethod,
    },
    turns: a.turns.map((t) => ({ ...t, reductionPct: pct(t.baselineInputTokens, t.actualInputTokens) })),
    totals: {
      turns: a.turns.length,
      baselineInputTokens: baseTotal,
      actualInputTokens: actualTotal,
      providerReportedInputTokens: a.turns.reduce((s, t) => s + t.providerReportedInputTokens, 0),
      reductionPct: pct(baseTotal, actualTotal),
      peakBaselineContext: Math.max(0, ...a.turns.map((t) => t.baselineInputTokens)),
      peakActualContext: Math.max(0, ...a.turns.map((t) => t.actualInputTokens)),
      outputTokens: a.turns.reduce((s, t) => s + t.outputTokens, 0),
      costUsd: Math.round(a.turns.reduce((s, t) => s + t.costUsd, 0) * 10000) / 10000,
    },
    mechanisms: [
      'JIT context: no repository content at session start; api_map / outline / read_file(line ranges) / search / read_standard fetch on demand',
      'compact tool returns: pass/fail lines and summaries; raw logs written to runs/<run>/logs and referenced by path',
      'history compaction: older tool results shrink to one line, older write arguments shrink to a size marker',
      'rules live in hooks/checks (zero prompt tokens until they fire); system prompt is ~12 lines',
    ],
  };
  const file = join(dir, `${a.runId}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
  return relPosix(HARNESS_ROOT, file);
}

export function writeRunReport(a: { runId: string; runDir: string; state: RunState; gate: GateResult; driver: Driver; baseline: boolean; tokenReport: string; turns: number }): void {
  const { state, gate } = a;
  const blocks = state.events.filter((e) => e.decision === 'block');
  const ledger = [...state.ledger.values()].sort((x, y) => x.testFile.localeCompare(y.testFile));
  const proven = gate.gates.filter((g) => g.status === 'pass').map((g) => `${g.name}: ${g.detail.split('\n')[0] ?? ''}`);
  const failed = gate.gates.filter((g) => g.status === 'fail').map((g) => `${g.name}: ${g.detail.split('\n')[0] ?? ''}`);
  const unproven = [
    ...gate.gates.filter((g) => g.status === 'unproven').map((g) => `${g.name}: ${g.detail.split('\n')[0] ?? ''}`),
    ...(gate.check?.rules.filter((r) => r.result.status === 'unproven').map((r) => `check ${r.id}: ${r.result.note ?? ''}`) ?? []),
  ];
  const notApplicable = gate.check?.rules.filter((r) => r.result.status === 'n/a').map((r) => `${r.id}: ${r.result.note ?? 'nothing to check'}`) ?? [];
  const json = {
    runId: a.runId,
    task: state.task.id,
    mode: state.task.mode,
    driver: a.driver.label,
    model: a.driver.model,
    tokenMode: a.baseline ? 'baseline' : 'jit',
    workspace: relPosix(HARNESS_ROOT, state.workspace),
    green: gate.green,
    turns: a.turns,
    gates: gate.gates,
    verdictPct: gate.check?.verdictPct ?? 0,
    writtenFiles: [...state.writtenFiles].sort(),
    redGreenLedger: ledger,
    hookBlocks: blocks.length,
    hookEvents: state.events,
    honesty: { proven, failed, unproven, notApplicable },
    tokenReport: a.tokenReport,
    contractSnapshot: state.contractSnapshotPath ? relPosix(HARNESS_ROOT, state.contractSnapshotPath) : null,
  };
  writeFileSync(join(a.runDir, 'report.json'), JSON.stringify(json, null, 2) + '\n');
  if (gate.check) writeFileSync(join(a.runDir, 'check.txt'), gate.check.text + '\n');

  const md = [
    `# Run ${a.runId}`,
    '',
    `- task: \`${state.task.id}\` (${state.task.mode}), driver: \`${a.driver.label}\` (${a.driver.model}), token mode: ${a.baseline ? 'baseline' : 'jit'}`,
    `- workspace: \`${json.workspace}\``,
    `- verdict: **${gate.green ? 'GREEN' : 'NOT GREEN'}** after ${a.turns} turns; hook blocks: ${blocks.length}`,
    `- token report: \`${a.tokenReport}\``,
    '',
    '## Gates',
    '```',
    ...gate.lines,
    '```',
    '',
    '## Honesty boundary',
    '**Proven by the harness (deterministic, re-run at the end):**',
    ...(proven.length ? proven.map((p) => `- ${p}`) : ['- nothing']),
    '',
    '**Failed:**',
    ...(failed.length ? failed.map((p) => `- ${p}`) : ['- none']),
    '',
    '**UNPROVEN (skipped or could not run - never counted as green):**',
    ...(unproven.length ? unproven.map((p) => `- ${p}`) : ['- none']),
    '',
    '**Not applicable:**',
    ...(notApplicable.length ? notApplicable.map((p) => `- ${p}`) : ['- none']),
    '',
    '**Not covered by any check (a human must verify):** business semantics beyond the task behaviours, persistence (stores are in-memory), authn/authz, performance, and whether the tests assert the right things.',
    '',
    '## Red/green ledger (from the harness runner only)',
    '| test file | ever red | last status |',
    '|---|---|---|',
    ...ledger.map((l) => `| ${l.testFile} | ${l.everRed ? 'yes' : 'no'} | ${l.status} |`),
    '',
    '## Hook blocks',
    ...(blocks.length ? blocks.map((b) => `- turn ${b.turn} \`${b.tool}\` blocked by **${b.hook}**: ${(b.feedback ?? '').slice(0, 220)}`) : ['- none']),
    '',
    '## Standards check',
    '```',
    gate.check?.text ?? 'not run',
    '```',
  ].join('\n');
  writeFileSync(join(a.runDir, 'report.md'), md + '\n');
}
