/**
 * Finish gates. Run by the harness when the model calls finish, and again before
 * any report or ship. Nothing here takes the model's word for anything.
 *   1. tests: the harness runner runs every test; all must pass (zero tests = UNPROVEN)
 *   2. observed-red audit: every source file written this run has a covering test
 *      the harness saw failing
 *   3. standards: the full check (static + runtime + contract drift) reads 100%
 */
import { compactReport } from '../checks/engine.ts';
import { testsCovering } from '../hooks/test-map.ts';
import type { CheckReport, HarnessServices, RunState, TestRunResult } from './types.ts';

export interface GateResult {
  green: boolean;
  lines: string[];
  gates: { name: string; status: 'pass' | 'fail' | 'unproven'; detail: string }[];
  tests?: TestRunResult;
  check?: CheckReport;
}

export async function finishGates(state: RunState, services: HarnessServices): Promise<GateResult> {
  const gates: GateResult['gates'] = [];

  const tests = await services.runTests();
  if (!tests.ran) gates.push({ name: 'tests', status: 'unproven', detail: `tests did not run: ${tests.error ?? ''}` });
  else if (tests.files.length === 0) gates.push({ name: 'tests', status: 'unproven', detail: 'no test files found' });
  else if (tests.failed > 0) gates.push({ name: 'tests', status: 'fail', detail: `${tests.failed} failing: ${tests.files.filter((f) => f.status === 'fail').map((f) => `${f.file} (${f.failures[0] ?? ''})`).join('; ')}` });
  else gates.push({ name: 'tests', status: 'pass', detail: `${tests.passed}/${tests.files.length} test files pass` });

  const written = [...state.writtenFiles].filter((f) => f.startsWith('src/') && f.endsWith('.ts'));
  const unproven = written.filter((f) => !testsCovering(state.workspace, f).some((t) => state.ledger.get(t)?.everRed));
  if (written.length === 0) gates.push({ name: 'observed-red', status: state.task.mode === 'greenfield' ? 'fail' : 'unproven', detail: 'no source file was written in this run' });
  else if (unproven.length) gates.push({ name: 'observed-red', status: 'fail', detail: `no observed-red test for: ${unproven.join(', ')}` });
  else gates.push({ name: 'observed-red', status: 'pass', detail: `${written.length}/${written.length} written source files have an observed-red covering test` });

  const check = await services.runChecks({ runtime: true });
  const anyFail = check.rules.some((r) => r.result.status === 'fail');
  gates.push({ name: 'standards', status: check.green ? 'pass' : anyFail ? 'fail' : 'unproven', detail: compactReport(check) });

  const green = gates.every((g) => g.status === 'pass');
  const lines = gates.map((g) => `${g.name.padEnd(13)} ${g.status === 'pass' ? 'pass' : g.status.toUpperCase()}  ${g.detail}`);
  return { green, lines, gates, tests, check };
}
