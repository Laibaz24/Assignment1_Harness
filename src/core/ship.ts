/**
 * Harness-owned shipping. The agent has no git tool; only this step branches,
 * commits, pushes and opens the PR - and only after re-running every gate itself.
 * Never commits on red, never pushes to a protected branch, never force-pushes.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { runCheck } from '../checks/engine.ts';
import { exec } from './exec.ts';
import { HARNESS_ROOT, loadRegistry } from './registry.ts';
import { runTests } from './runner.ts';

export const PROTECTED_BRANCH = /^(main|master|develop|trunk|release\/.*|prod(uction)?)$/;

const ReportSchema = z.object({
  runId: z.string(),
  task: z.string(),
  mode: z.string(),
  workspace: z.string(),
  green: z.boolean(),
  tokenReport: z.string(),
  contractSnapshot: z.string().nullable(),
});

export interface ShipStep { step: string; status: 'pass' | 'fail' | 'unproven' | 'skipped'; detail: string }

export async function ship(opts: { runId: string; base?: string; dryRun?: boolean; remote?: string }): Promise<{ ok: boolean; steps: ShipStep[] }> {
  const steps: ShipStep[] = [];
  const done = (ok: boolean): { ok: boolean; steps: ShipStep[] } => {
    const runDir = join(HARNESS_ROOT, 'runs', opts.runId);
    if (existsSync(runDir)) writeFileSync(join(runDir, 'ship.json'), JSON.stringify({ at: new Date().toISOString(), ok, steps }, null, 2) + '\n');
    return { ok, steps };
  };
  const git = (args: string[]) => exec('git', args, { cwd: HARNESS_ROOT, timeoutMs: 120_000 });

  const reportPath = join(HARNESS_ROOT, 'runs', opts.runId, 'report.json');
  if (!existsSync(reportPath)) {
    steps.push({ step: 'load run', status: 'fail', detail: `no report at runs/${opts.runId}/report.json` });
    return done(false);
  }
  const report = ReportSchema.parse(JSON.parse(readFileSync(reportPath, 'utf8')));
  if (!report.green) {
    steps.push({ step: 'run verdict', status: 'fail', detail: 'run did not end green; refusing to ship' });
    return done(false);
  }
  steps.push({ step: 'run verdict', status: 'pass', detail: 'run report is green' });

  // Re-run the gates now. A stored "green" is not trusted.
  const ws = resolve(HARNESS_ROOT, report.workspace);
  const tests = await runTests(ws, undefined, () => 'not logged');
  const testsOk = tests.ran && tests.files.length > 0 && tests.failed === 0;
  steps.push({ step: 'tests (fresh)', status: testsOk ? 'pass' : 'fail', detail: tests.ran ? `${tests.passed} pass, ${tests.failed} fail` : tests.error ?? 'did not run' });
  const registry = await loadRegistry();
  const check = await runCheck(ws, {
    runtime: true,
    extraRules: registry.rules,
    ...(report.contractSnapshot ? { contractBaseline: resolve(HARNESS_ROOT, report.contractSnapshot) } : {}),
  });
  steps.push({ step: 'standards (fresh)', status: check.green ? 'pass' : 'fail', detail: `verdict ${check.verdictPct}%` });
  if (!testsOk || !check.green) return done(false);

  const inRepo = await git(['rev-parse', '--is-inside-work-tree']);
  if (inRepo.code !== 0) {
    steps.push({ step: 'git', status: 'unproven', detail: 'harness root is not a git repository; nothing shipped' });
    return done(false);
  }
  const current = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  const base = opts.base ?? current;
  const branch = `harness/${opts.runId}`.toLowerCase();
  if (PROTECTED_BRANCH.test(branch)) {
    steps.push({ step: 'branch', status: 'fail', detail: `refusing protected branch ${branch}` });
    return done(false);
  }
  const paths = [report.workspace, `runs/${opts.runId}`, report.tokenReport];
  if (opts.dryRun) {
    steps.push({ step: 'plan', status: 'skipped', detail: `dry run: would branch ${branch} from ${current}, commit [${paths.join(', ')}], push to ${opts.remote ?? 'origin'}, open PR into ${base}` });
    return done(true);
  }

  const sw = await git(['switch', '-c', branch]);
  if (sw.code !== 0) {
    steps.push({ step: 'branch', status: 'fail', detail: sw.stderr.trim().slice(0, 200) });
    return done(false);
  }
  steps.push({ step: 'branch', status: 'pass', detail: `${branch} from ${current}` });
  try {
    const add = await git(['add', '--', ...paths]);
    const commit = await git(['commit', '-m', `feat(${report.task}): governed change from harness run ${opts.runId}`, '-m', `All gates green (tests, observed-red, standards ${check.verdictPct}%).\nReport: runs/${opts.runId}/report.md`]);
    if (add.code !== 0 || commit.code !== 0) {
      steps.push({ step: 'commit', status: 'fail', detail: (add.stderr + commit.stderr + commit.stdout).trim().slice(0, 200) });
      return done(false);
    }
    steps.push({ step: 'commit', status: 'pass', detail: (await git(['rev-parse', '--short', 'HEAD'])).stdout.trim() });

    const remote = opts.remote ?? 'origin';
    const remotes = (await git(['remote'])).stdout.split('\n').map((s) => s.trim());
    if (!remotes.includes(remote)) {
      steps.push({ step: 'push', status: 'unproven', detail: `no "${remote}" remote configured; commit is local only` });
      return done(false);
    }
    const push = await git(['push', '-u', remote, branch]);
    if (push.code !== 0) {
      steps.push({ step: 'push', status: 'fail', detail: push.stderr.trim().slice(0, 200) });
      return done(false);
    }
    steps.push({ step: 'push', status: 'pass', detail: `${remote}/${branch}` });

    const body = `Opened by the harness after all gates were green.\n\n- run report: runs/${opts.runId}/report.md\n- token report: ${report.tokenReport}\n- standards verdict: ${check.verdictPct}%\n\n\`\`\`\n${check.text.split('# summary')[1]?.trim() ?? ''}\n\`\`\`\n`;
    const pr = await exec('gh', ['pr', 'create', '--base', base, '--head', branch, '--title', `[harness] ${report.task} (${opts.runId})`, '--body', body], { cwd: HARNESS_ROOT, timeoutMs: 120_000 });
    if (pr.code !== 0) {
      steps.push({ step: 'pull request', status: 'unproven', detail: `gh pr create failed (${pr.stderr.trim().slice(0, 160) || 'gh not installed'}); branch is pushed` });
      return done(false);
    }
    steps.push({ step: 'pull request', status: 'pass', detail: pr.stdout.trim() });
    return done(true);
  } finally {
    await git(['switch', current]);
  }
}
