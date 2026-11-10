/**
 * The harness's own test runner. "Observed red" means observed HERE: the ledger is
 * only ever updated from vitest's JSON report, never from anything the model says.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { z } from 'zod';
import { BIN, node } from './exec.ts';
import type { RunState, TestRunResult } from './types.ts';

const VitestJson = z.object({
  testResults: z.array(
    z.object({
      name: z.string(),
      status: z.string(),
      message: z.string().optional(),
      assertionResults: z
        .array(z.object({ fullName: z.string(), status: z.string(), failureMessages: z.array(z.string()).optional() }))
        .optional(),
    }),
  ),
});

export const toPosix = (p: string): string => p.replace(/\\/g, '/');

export async function runTests(
  workspace: string,
  files: string[] | undefined,
  log: (name: string, content: string) => string,
): Promise<TestRunResult> {
  const tmp = mkdtempSync(join(tmpdir(), 'harness-vitest-'));
  const out = join(tmp, 'report.json');
  // Human-readable default reporter -> raw log; JSON reporter -> the only thing the ledger trusts.
  const args = [BIN.vitest, 'run', '--root', workspace, '--reporter=default', '--reporter=json', `--outputFile.json=${out}`];
  if (files?.length) args.push(...files);
  const res = await node(args, { cwd: workspace, timeoutMs: 240_000 });
  const rawOutput = `${res.stdout}\n${res.stderr}`.trim();
  const rawLogPath = log('vitest', `$ vitest ${args.slice(1).join(' ')}\nexit ${res.code}\n${rawOutput}`);
  try {
    if (!existsSync(out)) {
      return { ran: false, files: [], passed: 0, failed: 0, rawLogPath, rawOutput, error: `vitest produced no report (exit ${res.code}${res.timedOut ? ', timed out' : ''})` };
    }
    const parsed = VitestJson.safeParse(JSON.parse(readFileSync(out, 'utf8')));
    if (!parsed.success) return { ran: false, files: [], passed: 0, failed: 0, rawLogPath, rawOutput, error: 'unreadable vitest report' };
    const fileResults = parsed.data.testResults.map((t) => {
      const failures = (t.assertionResults ?? [])
        .filter((a) => a.status === 'failed')
        .map((a) => `${a.fullName}: ${firstLine(a.failureMessages?.[0] ?? '')}`);
      if (t.status !== 'passed' && failures.length === 0) failures.push(firstLine(t.message ?? 'suite failed to load'));
      return { file: toPosix(relative(workspace, t.name)), status: t.status === 'passed' ? ('pass' as const) : ('fail' as const), failures };
    });
    return {
      ran: true,
      files: fileResults,
      passed: fileResults.filter((f) => f.status === 'pass').length,
      failed: fileResults.filter((f) => f.status === 'fail').length,
      rawLogPath,
      rawOutput,
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function firstLine(s: string): string {
  const line = s.split('\n').find((l) => l.trim().length > 0) ?? '';
  return line.trim().slice(0, 240);
}

/** Record a run in the red/green ledger. A file that ever failed keeps everRed=true. */
export function recordLedger(state: RunState, result: TestRunResult): void {
  if (!result.ran) return;
  const at = new Date().toISOString();
  for (const f of result.files) {
    const prev = state.ledger.get(f.file);
    state.ledger.set(f.file, { testFile: f.file, status: f.status, at, everRed: (prev?.everRed ?? false) || f.status === 'fail' });
  }
}
