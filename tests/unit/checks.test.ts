import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCheck } from '../../src/checks/engine.ts';
import { HARNESS_ROOT } from '../../src/core/registry.ts';

const BAD = join(HARNESS_ROOT, 'tests', 'fixtures', 'bad-api');
const GOOD = join(HARNESS_ROOT, 'tests', 'fixtures', 'sample-api');

describe('standards checks', () => {
  it('fail every standard on a non-compliant API, with file:line locations', async () => {
    const r = await runCheck(BAD, { runtime: false });
    const status = Object.fromEntries(r.rules.map((x) => [x.id, x.result.status]));
    expect(status['zod-boundary']).toBe('fail');
    expect(status['zod-infer']).toBe('fail');
    expect(status['problem-json']).toBe('fail');
    expect(status['strict-types']).toBe('fail');
    expect(status['rest-conventions']).toBe('fail');
    expect(status['tsc --strict']).toBe('fail');
    expect(status['problem-json:runtime']).toBe('unproven');
    expect(r.green).toBe(false);
    expect(r.text).toMatch(/zod-boundary\s+FAIL\s+src\/app\.ts:\d+/);
    expect(r.text).toMatch(/problem-json\s+FAIL\s+src\/app\.ts:\d+\s+ad-hoc 400 response/);
    expect(r.text).toMatch(/strict-types\s+FAIL\s+src\/app\.ts:\d+\s+explicit `any`/);
    expect(r.text).toMatch(/rest-conventions\s+FAIL\s+src\/app\.ts:\d+\s+GET \/user: path is not under a versioned base/);
    expect(r.text).toMatch(/UNPROVEN/);
  }, 120_000);

  it('a skipped runtime probe is UNPROVEN, never green', async () => {
    const r = await runCheck(GOOD, { runtime: false });
    expect(r.unproven).toContain('problem-json:runtime');
    expect(r.green).toBe(false);
    expect(r.verdictPct).toBeLessThan(100);
  }, 120_000);

  it('passes 100% on the compliant sample API', async () => {
    const r = await runCheck(GOOD, { runtime: true });
    expect(r.text).toContain('-> all checks green');
    expect(r.verdictPct).toBe(100);
    expect(r.green).toBe(true);
  }, 180_000);
});
