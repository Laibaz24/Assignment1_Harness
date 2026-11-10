/** Post-write: type-check the workspace and report errors in the file just written (compact, record-only). */
import { BIN, node } from '../core/exec.ts';
import { defineHook } from '../core/plugin.ts';

export default defineHook({
  name: 'typecheck-on-write',
  phase: 'post',
  appliesTo: (tool) => tool.kind === 'write',
  async run(ev) {
    if (ev.path === undefined || !ev.path.endsWith('.ts') || ev.output?.isError) return { decision: 'pass' };
    const res = await node([BIN.tsc, '--noEmit', '-p', 'tsconfig.json', '--pretty', 'false'], { cwd: ev.ctx.state.workspace, timeoutMs: 120_000 });
    const mine = (res.stdout + res.stderr)
      .split('\n')
      .map((l) => l.trim().replace(/\\/g, '/'))
      .filter((l) => l.startsWith(`${ev.path}(`));
    if (mine.length === 0) return { decision: 'pass' };
    return { decision: 'record', feedback: `tsc: ${mine.length} error(s) in ${ev.path}:\n${mine.slice(0, 5).join('\n')}` };
  },
});
