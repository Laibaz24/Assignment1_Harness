/**
 * Harness addition (not in sf-harness): contract-drift gate.
 * Compares the API's current contract (derived from code + Zod schemas) with the
 * snapshot the harness took before the change. Any breaking change not declared in
 * the task file's allowBreaking list fails. One unit per pre-existing route.
 */
import { existsSync, readFileSync } from 'node:fs';
import { defineRule } from '../../core/plugin.ts';
import { ContractSchema, diffContracts, extractContract, type Contract } from '../contract.ts';

export default defineRule({
  id: 'contract-drift',
  category: 'gate',
  description: 'Brownfield changes must not break the existing API contract (routes, statuses, request/response schemas).',
  async run(ctx) {
    const path = ctx.options.contractBaseline;
    if (!path) return { status: 'n/a', unit: 'routes', passed: 0, total: 0, findings: [], note: 'no baseline contract (greenfield, or pass --contract <file>)' };
    if (!existsSync(path)) return { status: 'unproven', unit: 'routes', passed: 0, total: 0, findings: [], note: `baseline contract ${path} missing` };
    const before = ContractSchema.parse(JSON.parse(readFileSync(path, 'utf8'))) as Contract;
    const after = await extractContract(ctx.routes);
    const { findings, additive } = diffContracts(before, after, ctx.options.allowBreaking ?? []);
    const units = new Map<string, boolean>();
    for (const f of findings) {
      const key = f.message.split(': ')[0] ?? f.message;
      units.set(key, (units.get(key) ?? true) && f.ok);
    }
    const total = units.size;
    const passed = [...units.values()].filter(Boolean).length;
    const result = { status: total === 0 ? ('n/a' as const) : passed === total ? ('pass' as const) : ('fail' as const), unit: 'routes', passed, total, findings };
    return additive.length ? { ...result, note: `additive: ${additive.join('; ')}`.slice(0, 400) } : result;
  },
});
