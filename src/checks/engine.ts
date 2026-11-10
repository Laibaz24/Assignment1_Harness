/**
 * The standards check engine behind `harness check --api <dir>`, the run_checks tool
 * and the finish gate. Built-in rules live in ./rules; extra rules come from the
 * registry (src/registry/linters, src/registry/validators) and join the same report.
 */
import { relative, resolve } from 'node:path';
import { exec } from '../core/exec.ts';
import { toPosix } from '../core/runner.ts';
import type { CheckReport, Finding, RuleContext, RuleDef, RuleResult } from '../core/types.ts';
import { extractRoutes, isTestFile, loadProject } from './ast.ts';
import contractDrift from './rules/contract-drift.ts';
import problemJson from './rules/problem-json.ts';
import problemJsonRuntime from './rules/problem-json-runtime.ts';
import restConventions from './rules/rest-conventions.ts';
import strictTypes from './rules/strict-types.ts';
import tscStrict from './rules/tsc-strict.ts';
import zodBoundary from './rules/zod-boundary.ts';
import zodInfer from './rules/zod-infer.ts';

export const BUILTIN_RULES: RuleDef[] = [zodBoundary, zodInfer, problemJson, problemJsonRuntime, tscStrict, strictTypes, restConventions, contractDrift];

export interface CheckOptions {
  runtime?: boolean;
  contractBaseline?: string;
  allowBreaking?: string[];
  extraRules?: RuleDef[];
}

export function buildContext(apiDirIn: string, opts: CheckOptions): RuleContext {
  const apiDir = resolve(apiDirIn);
  const rel = (f: string): string => toPosix(relative(apiDir, f));
  const project = loadProject(apiDir);
  const all = project.getSourceFiles().filter((sf) => !sf.getFilePath().includes('/node_modules/'));
  const sourceFiles = all.filter((sf) => !isTestFile(rel(sf.getFilePath())) && rel(sf.getFilePath()).startsWith('src/'));
  const testFiles = all.filter((sf) => isTestFile('/' + rel(sf.getFilePath())));
  const options: RuleContext['options'] = { runtime: opts.runtime ?? true };
  if (opts.contractBaseline !== undefined) options.contractBaseline = opts.contractBaseline;
  if (opts.allowBreaking !== undefined) options.allowBreaking = opts.allowBreaking;
  return {
    apiDir,
    project,
    sourceFiles,
    testFiles,
    routes: extractRoutes(sourceFiles, rel),
    rel,
    options,
    exec: (cmd, args, o) => exec(cmd, args, o ?? {}),
  };
}

const pad = (s: string, n: number): string => (s.length >= n ? s + ' ' : s + ' '.repeat(n - s.length));
const loc = (f: Finding): string => (f.line ? `${f.file}:${f.line}` : f.file);
const LABEL: Record<RuleResult['status'], string> = { pass: 'pass', fail: 'FAIL', unproven: 'UNPROVEN', 'n/a': 'n/a' };

export async function runCheck(apiDir: string, opts: CheckOptions = {}): Promise<CheckReport> {
  const ctx = buildContext(apiDir, opts);
  const rules = [...BUILTIN_RULES, ...(opts.extraRules ?? [])];
  const results: CheckReport['rules'] = [];
  for (const rule of rules) {
    let result: RuleResult;
    try {
      result = await rule.run(ctx);
    } catch (e) {
      result = { status: 'unproven', unit: 'checks', passed: 0, total: 0, findings: [], note: `rule crashed: ${String(e).slice(0, 200)}` };
    }
    results.push({ id: rule.id, category: rule.category, result });
  }

  const width = Math.max(18, ...results.map((r) => r.id.length + 2));
  const detail: string[] = [];
  for (const { id, result } of results) {
    const byFile = new Map<string, Finding[]>();
    for (const f of result.findings) byFile.set(f.file, [...(byFile.get(f.file) ?? []), f]);
    for (const [file, fs] of byFile) {
      const bad = fs.filter((f) => !f.ok);
      if (bad.length === 0) detail.push(`${pad(id, width)}${pad('pass', 9)}${file}`);
      else for (const f of bad) detail.push(`${pad(id, width)}${pad('FAIL', 9)}${pad(loc(f), 34)}${f.message}`);
    }
    if (result.status === 'unproven') detail.push(`${pad(id, width)}${pad('UNPROVEN', 9)}${result.note ?? ''}`);
  }

  const summary: string[] = [];
  for (const { id, result } of results) {
    const measure = result.display ?? (result.status === 'n/a' ? (result.note ?? 'nothing to check') : `${result.passed}/${result.total} ${result.unit}`);
    const note = result.status !== 'n/a' && result.note ? `  (${result.note})` : '';
    summary.push(`${pad(id, width)}${pad(LABEL[result.status], 9)}${measure}${note}`);
  }
  const counted = results.filter((r) => r.result.status !== 'n/a');
  const passing = counted.filter((r) => r.result.status === 'pass').length;
  const verdictPct = counted.length === 0 ? 0 : Math.floor((passing / counted.length) * 100);
  const unproven = counted.filter((r) => r.result.status === 'unproven').map((r) => r.id);
  const green = counted.length > 0 && passing === counted.length;
  summary.push(`${pad('verdict', width)}${pad(`${verdictPct}%`, 9)}${green ? '-> all checks green' : `-> NOT green${unproven.length ? ` (UNPROVEN: ${unproven.join(', ')})` : ''}`}`);

  const text = [`# per-file results (${toPosix(ctx.apiDir)})`, ...detail, '', '# summary', ...summary].join('\n');
  return { apiDir: ctx.apiDir, rules: results, verdictPct, green, unproven, text };
}

/** Compact form for tool returns: only failing / unproven lines + verdict. */
export function compactReport(r: CheckReport): string {
  const lines = r.text.split('\n');
  const bad = lines.filter((l) => /\s(FAIL|UNPROVEN)\s/.test(l));
  const summaryStart = lines.indexOf('# summary');
  const verdict = lines[lines.length - 1] ?? '';
  const summary = lines.slice(summaryStart + 1, -1).map((l) => l.replace(/\s+/g, ' ').trim());
  return [...bad.slice(0, 25), bad.length > 25 ? `... ${bad.length - 25} more failing lines` : '', summary.join(' | '), verdict.replace(/\s+/g, ' ')].filter(Boolean).join('\n');
}
