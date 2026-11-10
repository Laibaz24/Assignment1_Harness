/**
 * Standard 03 - Strict type safety (compiler half).
 * Runs tsc with --strict and --noUncheckedIndexedAccess forced on the command line,
 * so a weakened tsconfig cannot make this pass. Also requires the project's own
 * tsconfig to declare both flags.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BIN } from '../../core/exec.ts';
import { defineRule } from '../../core/plugin.ts';
import type { Finding } from '../../core/types.ts';

export default defineRule({
  id: 'tsc --strict',
  category: 'standard',
  description: 'tsc --noEmit passes with strict and noUncheckedIndexedAccess.',
  async run(ctx) {
    const tsconfig = join(ctx.apiDir, 'tsconfig.json');
    if (!existsSync(tsconfig)) return { status: 'fail', unit: 'errors', passed: 0, total: 1, findings: [{ file: 'tsconfig.json', ok: false, message: 'missing tsconfig.json' }], display: 'no tsconfig.json' };
    const findings: Finding[] = [];
    const cfg = readFileSync(tsconfig, 'utf8');
    for (const flag of ['strict', 'noUncheckedIndexedAccess']) {
      if (!new RegExp(`"${flag}"\\s*:\\s*true`).test(cfg)) findings.push({ file: 'tsconfig.json', ok: false, message: `tsconfig does not set "${flag}": true` });
    }
    const res = await ctx.exec(process.execPath, [BIN.tsc, '--noEmit', '-p', tsconfig, '--strict', '--noUncheckedIndexedAccess', '--pretty', 'false'], { cwd: ctx.apiDir, timeoutMs: 180_000 });
    for (const line of (res.stdout + res.stderr).split('\n')) {
      const m = /^(.+?)\((\d+),\d+\): error (TS\d+): (.*)$/.exec(line.trim());
      if (m) findings.push({ file: ctx.rel(join(ctx.apiDir, m[1] ?? '')), line: Number(m[2]), ok: false, message: `${m[3]} ${m[4] ?? ''}`.slice(0, 200) });
    }
    if (res.code !== 0 && findings.length === 0) findings.push({ file: 'tsc', ok: false, message: `tsc exited ${res.code}: ${(res.stderr || res.stdout).slice(0, 200)}` });
    const errors = findings.length;
    return {
      status: errors === 0 ? 'pass' : 'fail',
      unit: 'errors',
      passed: errors === 0 ? 1 : 0,
      total: 1,
      findings: errors === 0 ? [{ file: 'tsconfig.json', ok: true, message: 'tsc --noEmit --strict --noUncheckedIndexedAccess clean' }] : findings,
      display: `${errors} errors`,
    };
  },
});
