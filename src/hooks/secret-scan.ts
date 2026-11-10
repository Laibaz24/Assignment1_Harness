/** Pre-write: refuse content that looks like a credential. Keys come from the environment only. */
import { defineHook } from '../core/plugin.ts';

const PATTERNS: [RegExp, string][] = [
  [/sk-ant-[A-Za-z0-9_-]{20,}/, 'provider API key'],
  [/sk-(proj-)?[A-Za-z0-9_-]{32,}/, 'provider API key'],
  [/AKIA[0-9A-Z]{16}/, 'AWS access key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  [/gh[pousr]_[A-Za-z0-9]{36,}/, 'GitHub token'],
];

export default defineHook({
  name: 'secret-scan',
  phase: 'pre',
  appliesTo: (tool) => tool.kind === 'write',
  run(ev) {
    for (const [re, what] of PATTERNS) {
      if (ev.nextContent !== undefined && re.test(ev.nextContent)) {
        return { decision: 'block', feedback: `content contains what looks like a ${what}; secrets come from the environment, never from files` };
      }
    }
    return { decision: 'pass' };
  },
});
