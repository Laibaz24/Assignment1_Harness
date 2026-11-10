import { describe, expect, it } from 'vitest';
import { breakingChanges, diffContracts, type Contract } from '../../src/checks/contract.ts';
import { compactHistory } from '../../src/core/compaction.ts';
import type { Message } from '../../src/core/types.ts';

const obj = (props: Record<string, unknown>, required: string[]) => ({ type: 'object', properties: props, required });
const str = { type: 'string' };

describe('contract diff', () => {
  it('flags removed response fields and new required request fields', () => {
    expect(breakingChanges(obj({ id: str, email: str }, ['id', 'email']), obj({ id: str }, ['id']), 'response', 'response')).toContain('response.email: field removed');
    expect(breakingChanges(obj({ a: str }, []), obj({ a: str, b: str }, ['b']), 'request', 'body')).toContain('body.b: new required field');
  });

  it('treats new optional request fields and new response fields as compatible', () => {
    expect(breakingChanges(obj({ a: str }, []), obj({ a: str, b: str }, []), 'request', 'body')).toEqual([]);
    expect(breakingChanges(obj({ a: str }, ['a']), obj({ a: str, b: str }, ['a', 'b']), 'response', 'response')).toEqual([]);
  });

  it('removed routes break unless allowed by the task', () => {
    const before: Contract = { generatedAt: '', routes: { 'GET /v1/a': { statuses: [200], schemas: {} } } };
    const after: Contract = { generatedAt: '', routes: {} };
    expect(diffContracts(before, after).findings.every((f) => !f.ok)).toBe(true);
    expect(diffContracts(before, after, ['GET /v1/a']).findings.every((f) => f.ok)).toBe(true);
  });
});

describe('history compaction', () => {
  it('pins the latest read of each file until that file is written (no re-read thrash)', () => {
    const body = (n: string): string => `${n}\n${'line\n'.repeat(60)}`;
    const read = (id: string, path: string): Message => ({ role: 'assistant', content: '', toolCalls: [{ id, name: 'read_file', args: { path } }] });
    const result = (id: string, content: string): Message => ({ role: 'tool', results: [{ callId: id, name: 'read_file', content, isError: false }] });
    const h: Message[] = [
      { role: 'user', content: 'brief' },
      read('r1', 'src/lib/a.ts'),
      result('r1', body('A')),
      read('r2', 'src/app.ts'),
      result('r2', body('APP')),
      { role: 'assistant', content: '', toolCalls: [{ id: 'w1', name: 'write_file', args: { path: 'src/app.ts', content: 'x' } }] },
      { role: 'tool', results: [{ callId: 'w1', name: 'write_file', content: 'overwrote src/app.ts', isError: false }] },
      read('r3', 'src/lib/b.ts'),
      result('r3', body('B')),
    ];
    const info = (c: { name: string; args: unknown }) => {
      const path = (c.args as { path: string }).path;
      return c.name === 'read_file' ? { readKey: `file:${path}:1-end` } : { writePath: path };
    };
    const c = compactHistory(h, info);
    expect(JSON.stringify(c[2])).toContain('line\\nline'); // a.ts still pinned two exchanges later
    expect(JSON.stringify(c[4])).toContain('[compacted]'); // app.ts read is stale after the write
    expect(c[8]).toEqual(h[8]);
  });

  it('elides executed write contents and shrinks old tool results, keeps the brief', () => {
    const big = 'x'.repeat(5000);
    const h: Message[] = [
      { role: 'user', content: 'brief' },
      { role: 'assistant', content: '', toolCalls: [{ id: '1', name: 'write_file', args: { path: 'a.ts', content: big } }] },
      { role: 'tool', results: [{ callId: '1', name: 'write_file', content: `created a.ts\n${'detail\n'.repeat(50)}`, isError: false }] },
      { role: 'assistant', content: '', toolCalls: [{ id: '2', name: 'run_tests', args: {} }] },
      { role: 'tool', results: [{ callId: '2', name: 'run_tests', content: 'FAIL\ndetail', isError: false }] },
    ];
    const c = compactHistory(h);
    expect(c[0]).toEqual(h[0]);
    expect(JSON.stringify(c)).not.toContain(big);
    expect(JSON.stringify(c[2])).toContain('[compacted]');
    expect(c[4]).toEqual(h[4]);
  });
});
