/** Pre-write: generated TypeScript may not contain `any`, non-null assertions or ts-ignore. Blocked before it reaches disk. */
import { scanContent } from '../checks/ast.ts';
import { defineHook } from '../core/plugin.ts';

export default defineHook({
  name: 'escape-hatches',
  phase: 'pre',
  appliesTo: (tool) => tool.kind === 'write',
  run(ev) {
    if (ev.path === undefined || !ev.path.endsWith('.ts') || ev.nextContent === undefined) return { decision: 'pass' };
    const hits = scanContent(ev.path, ev.nextContent);
    if (hits.length === 0) return { decision: 'pass' };
    return { decision: 'block', feedback: `REFUSED ${ev.path}: ${hits.slice(0, 5).map((h) => `line ${h.line}: ${h.message}`).join('; ')}` };
  },
});
