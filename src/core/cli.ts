/**
 * harness CLI.
 *   harness run --task <file> --driver <name> [--baseline] [--ship]
 *   harness check --api <dir> [--contract <file>] [--no-runtime] [--json]
 *   harness contract --api <dir> --out <file>
 *   harness ship --run <runId> [--base <branch>] [--dry-run]
 *   harness registry
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Command } from 'commander';
import { buildContext, runCheck } from '../checks/engine.ts';
import { extractContract } from '../checks/contract.ts';
import { createDriver, DRIVER_NAMES } from '../drivers/index.ts';
import { runTask } from './loop.ts';
import { HARNESS_ROOT, loadRegistry } from './registry.ts';
import { ship } from './ship.ts';
import { loadTask } from './workspace.ts';

// Provider keys come from the environment; a local, git-ignored .env is honoured.
const envFile = join(HARNESS_ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const program = new Command().name('harness').description('Agent harness for TypeScript REST APIs');

program
  .command('run')
  .requiredOption('--task <file>', 'task file (YAML)')
  .requiredOption('--driver <name>', DRIVER_NAMES.join(' | '))
  .option('--model <id>', 'override the driver model (driver config, never the task file)')
  .option('--script <file>', 'replay script (replay driver only; default tests/fixtures/replay/<task-id>.yaml)')
  .option('--baseline', 'disable context fetchers + compaction (token baseline run)', false)
  .option('--no-shadow', 'do not count the shadow baseline per turn')
  .option('--max-turns <n>', 'turn limit', '40')
  .option('--out <dir>', 'override the workspace directory')
  .option('--ship', 'ship (branch, commit, push, PR) if the run ends green', false)
  .option('--base <branch>', 'PR base branch')
  .action(async (o: { task: string; driver: string; model?: string; script?: string; baseline: boolean; shadow: boolean; maxTurns: string; out?: string; ship: boolean; base?: string }) => {
    const task = loadTask(o.task);
    const script = o.script ?? (o.driver === 'replay' ? join(HARNESS_ROOT, 'tests', 'fixtures', 'replay', `${task.id}.yaml`) : undefined);
    const driver = createDriver(o.driver, { ...(o.model ? { model: o.model } : {}), ...(script ? { script } : {}) });
    const result = await runTask({ taskPath: o.task, driver, baseline: o.baseline, shadow: o.shadow, maxTurns: Number(o.maxTurns), ...(o.out ? { out: o.out } : {}) });
    if (o.ship && result.green) {
      const s = await ship({ runId: result.runId, ...(o.base ? { base: o.base } : {}) });
      for (const st of s.steps) process.stdout.write(`ship ${st.step.padEnd(18)} ${st.status.toUpperCase().padEnd(9)} ${st.detail}\n`);
    }
    process.exitCode = result.green ? 0 : 1;
  });

program
  .command('check')
  .requiredOption('--api <dir>', 'API directory')
  .option('--contract <file>', 'baseline contract for the contract-drift gate')
  .option('--allow-breaking <keys>', 'comma-separated "METHOD /path" keys allowed to break')
  .option('--no-runtime', 'skip runtime probes (reported as UNPROVEN)')
  .option('--json', 'print JSON instead of text', false)
  .action(async (o: { api: string; contract?: string; allowBreaking?: string; runtime: boolean; json: boolean }) => {
    const registry = await loadRegistry();
    const report = await runCheck(resolve(o.api), {
      runtime: o.runtime,
      extraRules: registry.rules,
      ...(o.contract ? { contractBaseline: resolve(o.contract) } : {}),
      ...(o.allowBreaking ? { allowBreaking: o.allowBreaking.split(',').map((s) => s.trim()) } : {}),
    });
    process.stdout.write((o.json ? JSON.stringify({ ...report, rules: report.rules.map((r) => ({ id: r.id, category: r.category, ...r.result })) }, null, 2) : report.text) + '\n');
    process.exitCode = report.green ? 0 : 1;
  });

program
  .command('contract')
  .requiredOption('--api <dir>', 'API directory')
  .requiredOption('--out <file>', 'where to write the contract snapshot')
  .action(async (o: { api: string; out: string }) => {
    const contract = await extractContract(buildContext(resolve(o.api), {}).routes);
    writeFileSync(resolve(o.out), JSON.stringify(contract, null, 2) + '\n');
    process.stdout.write(`${Object.keys(contract.routes).length} routes -> ${o.out}\n`);
  });

program
  .command('ship')
  .requiredOption('--run <runId>', 'run id (directory name under runs/)')
  .option('--base <branch>', 'PR base branch (default: current branch)')
  .option('--remote <name>', 'git remote', 'origin')
  .option('--dry-run', 'print the plan without touching git', false)
  .action(async (o: { run: string; base?: string; remote: string; dryRun: boolean }) => {
    const s = await ship({ runId: o.run, dryRun: o.dryRun, remote: o.remote, ...(o.base ? { base: o.base } : {}) });
    for (const st of s.steps) process.stdout.write(`${st.step.padEnd(18)} ${st.status.toUpperCase().padEnd(9)} ${st.detail}\n`);
    process.exitCode = s.ok ? 0 : 1;
  });

program
  .command('registry')
  .description('list plugins discovered in src/registry')
  .action(async () => {
    const reg = await loadRegistry();
    for (const s of reg.sources) process.stdout.write(`${s.kind.padEnd(11)} ${s.file.padEnd(46)} ${s.names.join(', ')}\n`);
  });

program
  .command('tokens')
  .requiredOption('--report <file>', 'token report JSON')
  .action((o: { report: string }) => {
    const r = JSON.parse(readFileSync(resolve(o.report), 'utf8')) as { turns: { turn: number; baselineInputTokens: number; actualInputTokens: number; reductionPct: number }[]; totals: Record<string, number> };
    process.stdout.write('turn  baseline  actual  reduction\n');
    for (const t of r.turns) process.stdout.write(`${String(t.turn).padStart(4)}  ${String(t.baselineInputTokens).padStart(8)}  ${String(t.actualInputTokens).padStart(6)}  ${t.reductionPct}%\n`);
    process.stdout.write(`total ${r.totals['baselineInputTokens']} -> ${r.totals['actualInputTokens']} (${r.totals['reductionPct']}% reduction)\n`);
  });

program.parseAsync(process.argv).catch((e: unknown) => {
  process.stderr.write(`harness: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 2;
});
