/**
 * Standard 02 (runtime half). Boots the API and fires error-inducing requests.
 * If the API cannot be booted the rule is UNPROVEN, never pass.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { nodeTs } from '../../core/exec.ts';
import { defineRule } from '../../core/plugin.ts';
import { HARNESS_ROOT } from '../../core/registry.ts';
import type { Finding } from '../../core/types.ts';

const Output = z.union([
  z.object({ unproven: z.string() }),
  z.object({ results: z.array(z.object({ probe: z.string(), ok: z.boolean(), message: z.string() })) }),
]);

export default defineRule({
  id: 'problem-json:runtime',
  category: 'standard',
  description: 'Boots the API and verifies real error responses are RFC 7807 problem+json.',
  async run(ctx) {
    if (!ctx.options.runtime) return { status: 'unproven', unit: 'probes', passed: 0, total: 0, findings: [], note: 'runtime probes disabled (--no-runtime)' };
    const tmp = mkdtempSync(join(tmpdir(), 'harness-probe-'));
    try {
      const routesFile = join(tmp, 'routes.json');
      writeFileSync(routesFile, JSON.stringify(ctx.routes.map((r) => ({ method: r.method, path: r.path }))));
      const res = await nodeTs(join(HARNESS_ROOT, 'src', 'checks', 'runtime', 'probe.ts'), [ctx.apiDir, routesFile], { timeoutMs: 60_000 });
      let parsed: z.infer<typeof Output> | undefined;
      try {
        parsed = Output.parse(JSON.parse(res.stdout.trim().split('\n').pop() ?? ''));
      } catch {
        parsed = undefined;
      }
      if (!parsed) return { status: 'unproven', unit: 'probes', passed: 0, total: 0, findings: [], note: `probe produced no result: ${res.stderr.split('\n')[0] ?? ''}`.slice(0, 200) };
      if ('unproven' in parsed) return { status: 'unproven', unit: 'probes', passed: 0, total: 0, findings: [], note: parsed.unproven.slice(0, 200) };
      const findings: Finding[] = parsed.results.map((r) => ({ file: 'runtime', ok: r.ok, message: r.message }));
      const passed = findings.filter((f) => f.ok).length;
      return { status: findings.length === 0 ? 'unproven' : passed === findings.length ? 'pass' : 'fail', unit: 'probes', passed, total: findings.length, findings };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  },
});
