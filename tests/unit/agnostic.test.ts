/**
 * Model agnosticism guard: provider names, model ids and vendor tool-schema formats
 * may appear only inside src/drivers. Task files, hooks, checks, core and registry
 * plugins must not know which provider runs them.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HARNESS_ROOT } from '../../src/core/registry.ts';
import { toAnthropic } from '../../src/drivers/claude.ts';
import { toOpenAI } from '../../src/drivers/openai.ts';
import type { Message } from '../../src/core/types.ts';

const LEAK = /anthropic|openai|claude|\bgpt-|sonnet|opus|haiku|input_schema|tool_use|tool_calls|function_call/i;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

describe('model agnosticism', () => {
  const guarded = ['src/core', 'src/hooks', 'src/checks', 'src/registry', 'tasks'];
  for (const dir of guarded) {
    it(`no provider leak under ${dir}`, () => {
      const hits = files(join(HARNESS_ROOT, dir))
        .filter((f) => /\.(ts|ya?ml|json|md)$/.test(f))
        .flatMap((f) =>
          readFileSync(f, 'utf8')
            .split('\n')
            .map((line, i) => ({ f, i, line }))
            .filter(({ line }) => LEAK.test(line))
            .map(({ f, i, line }) => `${relative(HARNESS_ROOT, f)}:${i + 1}: ${line.trim()}`),
        );
      expect(hits).toEqual([]);
    });
  }

  const conversation: Message[] = [
    { role: 'user', content: 'task' },
    { role: 'assistant', content: 'reading', toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'src/app.ts' } }] },
    { role: 'tool', results: [{ callId: 'c1', name: 'read_file', content: '1| x', isError: false }] },
    { role: 'user', content: 'continue' },
  ];

  it('the same neutral conversation maps onto both providers', () => {
    const a = toAnthropic(conversation);
    expect(a.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    const o = toOpenAI('sys', conversation);
    expect(o.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user']);
  });
});
