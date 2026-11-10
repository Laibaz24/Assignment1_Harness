import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool } from '../../src/core/plugin.ts';
import type { HookEvent, RunState, ToolContext } from '../../src/core/types.ts';
import escapeHatches from '../../src/hooks/escape-hatches.ts';
import observedRed from '../../src/hooks/observed-red.ts';
import pathGuard from '../../src/hooks/path-guard.ts';
import secretScan from '../../src/hooks/secret-scan.ts';

const writeTool = defineTool({ name: 'write_file', description: '', kind: 'write', schema: z.object({ path: z.string() }), run: async () => ({ summary: '' }) });

let ws: string;
let state: RunState;

function ev(path: string, nextContent = 'export const x = 1;\n'): HookEvent {
  const ctx = { state, baseline: false, services: {} } as unknown as ToolContext;
  return { phase: 'pre', tool: writeTool, args: { path }, path, nextContent, ctx };
}

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'harness-hooks-'));
  mkdirSync(join(ws, 'tests'));
  mkdirSync(join(ws, 'src'));
  state = {
    runId: 't',
    task: { id: 't', mode: 'greenfield', target: 'x', goal: 'g', behaviours: ['b'] },
    workspace: ws,
    turn: 1,
    ledger: new Map(),
    writtenFiles: new Set(),
    protectedFiles: new Set(['src/lib/problem.ts', 'tsconfig.json']),
    baseline: false,
    events: [],
    finishAttempts: 0,
  };
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

describe('observed-red hook', () => {
  it('refuses a source file with no covering test', async () => {
    const d = await observedRed.run(ev('src/routes/users.ts'));
    expect(d.decision).toBe('block');
    expect(d.feedback).toContain('no test covers it');
  });

  it('refuses when the covering test was never seen failing by the harness runner', async () => {
    writeFileSync(join(ws, 'tests', 'api.test.ts'), '// @covers src/routes/users.ts\n');
    state.ledger.set('tests/api.test.ts', { testFile: 'tests/api.test.ts', status: 'pass', at: '', everRed: false });
    const d = await observedRed.run(ev('src/routes/users.ts'));
    expect(d.decision).toBe('block');
    expect(d.feedback).toContain('have not been observed failing');
  });

  it('allows the edit once the harness ledger recorded the test red (basename mapping)', async () => {
    writeFileSync(join(ws, 'tests', 'users.test.ts'), 'it("x", () => {})\n');
    state.ledger.set('tests/users.test.ts', { testFile: 'tests/users.test.ts', status: 'fail', at: '', everRed: true });
    expect((await observedRed.run(ev('src/routes/users.ts'))).decision).toBe('record');
  });

  it('does not gate test files', async () => {
    expect((await observedRed.run(ev('tests/users.test.ts'))).decision).toBe('pass');
  });
});

describe('path-guard hook', () => {
  it.each(['../outside.ts', '/etc/passwd', 'C:/x.ts', '.git/config', 'node_modules/x/index.ts', '.env', 'src/lib/problem.ts', 'tsconfig.json', 'run.sh'])('blocks %s', async (p) => {
    expect((await pathGuard.run(ev(p))).decision).toBe('block');
  });
  it('passes a normal source path', async () => {
    expect((await pathGuard.run(ev('src/routes/users.ts'))).decision).toBe('pass');
  });
});

describe('escape-hatches hook', () => {
  it('blocks any, non-null assertions and ts-ignore before they reach disk', async () => {
    const d = await escapeHatches.run(ev('src/a.ts', 'const a: any = 1;\nconst b = a!;\n// @ts-ignore\nconst c = 1;\n'));
    expect(d.decision).toBe('block');
    expect(d.feedback).toContain('line 1: explicit `any`');
    expect(d.feedback).toContain('line 2: non-null assertion');
    expect(d.feedback).toContain('line 3: type-check suppression');
  });
  it('passes clean code', async () => {
    expect((await escapeHatches.run(ev('src/a.ts', 'export const a: number = 1;\n'))).decision).toBe('pass');
  });
});

describe('secret-scan hook', () => {
  it('blocks content that looks like a provider key', async () => {
    const fake = 'sk-ant-' + 'a'.repeat(30);
    expect((await secretScan.run(ev('src/a.ts', `const k = '${fake}';`))).decision).toBe('block');
  });
});
