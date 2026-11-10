/**
 * Example tool plugin: contract_status. Brownfield only - shows the model, compactly,
 * whether its change currently breaks the contract snapshot the harness took at start.
 */
import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { buildContext } from '../../checks/engine.ts';
import { ContractSchema, diffContracts, extractContract, type Contract } from '../../checks/contract.ts';
import { defineTool } from '../../core/plugin.ts';

export default defineTool({
  name: 'contract_status',
  description: 'Brownfield: compare the current API contract with the pre-change snapshot. Lists breaking and additive changes.',
  kind: 'read',
  schema: z.object({}),
  async run(_args, ctx) {
    const snap = ctx.state.contractSnapshotPath;
    if (!snap || !existsSync(snap)) return { summary: 'no contract snapshot (greenfield run)' };
    const before = ContractSchema.parse(JSON.parse(readFileSync(snap, 'utf8'))) as Contract;
    const after = await extractContract(buildContext(ctx.state.workspace, {}).routes);
    const { findings, additive } = diffContracts(before, after, ctx.state.task.allowBreaking ?? []);
    const breaking = findings.filter((f) => !f.ok).map((f) => `BREAKING ${f.message}`);
    return { summary: [...(breaking.length ? breaking : ['no breaking changes']), ...additive.map((a) => `additive ${a}`)].join('\n') };
  },
});
