/** Pre-write: writes stay inside the workspace and never touch VCS, secrets, configs or harness-owned files. */
import { defineHook } from '../core/plugin.ts';

const FORBIDDEN = [/^\.git(\/|$)/, /(^|\/)node_modules\//, /(^|\/)\.env/, /^\.github\//, /(^|\/)package-lock\.json$/, /(^|\/)vitest\.config\./, /(^|\/)\.harness-workspace\.json$/];

export default defineHook({
  name: 'path-guard',
  phase: 'pre',
  appliesTo: (tool) => tool.kind === 'write',
  run(ev) {
    const p = ev.path;
    if (p === undefined) return { decision: 'block', feedback: 'write tool did not declare its target path' };
    if (p.startsWith('/') || p.split('/').includes('..') || /^[A-Za-z]:/.test(p)) return { decision: 'block', feedback: `path "${p}" must be relative to the workspace, without ".."` };
    if (FORBIDDEN.some((re) => re.test(p))) return { decision: 'block', feedback: `path "${p}" is off-limits to the agent` };
    if (ev.ctx.state.protectedFiles.has(p)) return { decision: 'block', feedback: `"${p}" is harness-owned (scaffold/config). Use it, do not rewrite it.` };
    if (!/\.(ts|json|md)$/.test(p)) return { decision: 'block', feedback: `only .ts, .json and .md files may be written (got "${p}")` };
    return { decision: 'pass' };
  },
});
