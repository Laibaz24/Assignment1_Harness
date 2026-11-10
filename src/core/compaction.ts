/**
 * History compaction (disabled in baseline mode).
 *
 *  - Working set: the latest result of each read (keyed by the tool's contextKey, e.g.
 *    "file:src/app.ts:1-40") stays verbatim until a write to that path makes it stale
 *    or a newer read of the same key supersedes it - within a size budget. Without
 *    this, recency-only compaction made models re-read the same files forever.
 *  - Every other tool result older than the last exchange shrinks to its first line.
 *  - Tool-call arguments in past assistant turns are already executed; long strings
 *    (file contents, edit texts) shrink to a size marker - the content is on disk.
 *  - The task brief (first message) is never touched.
 */
import type { Message, ToolCall } from './types.ts';

const KEEP_LAST_RESULTS = 1;
const ARG_LIMIT = 160;
const RESULT_LIMIT = 200;
const TEXT_LIMIT = 300;
/** Max characters of pinned read results (~8k tokens). Oldest pinned reads are dropped first. */
export const WORKING_SET_CHARS = 32_000;

/** How compaction learns what a call read or wrote, without knowing any tool by name. */
export type CallInfo = (call: ToolCall) => { readKey?: string; writePath?: string };

function elide(value: unknown): unknown {
  if (typeof value === 'string') return value.length > ARG_LIMIT ? `<${value.length} chars elided; content is on disk>` : value;
  if (Array.isArray(value)) return value.map(elide);
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, elide(v)]));
  return value;
}

function firstLine(s: string): string {
  if (s.length <= RESULT_LIMIT && !s.includes('\n')) return s;
  return `${(s.split('\n')[0] ?? '').slice(0, RESULT_LIMIT)} [compacted]`;
}

/** callIds whose results stay verbatim because they are the current, valid read of their key. */
function pinnedCalls(history: Message[], info: CallInfo): Set<string> {
  const latest = new Map<string, { callId: string; index: number; size: number }>();
  const calls = new Map<string, ToolCall>();
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    if (!m) continue;
    if (m.role === 'assistant') {
      for (const c of m.toolCalls) {
        calls.set(c.id, c);
        const { writePath } = info(c);
        if (writePath !== undefined) {
          // A write makes earlier reads of that file (and any whole-API map) stale.
          for (const k of [...latest.keys()]) if (k.startsWith(`file:${writePath}:`) || k === 'api_map') latest.delete(k);
        }
      }
    } else if (m.role === 'tool') {
      for (const r of m.results) {
        const call = calls.get(r.callId);
        const key = call && !r.isError ? info(call).readKey : undefined;
        if (key !== undefined) latest.set(key, { callId: r.callId, index: i, size: r.content.length });
      }
    }
  }
  const pinned = new Set<string>();
  let budget = WORKING_SET_CHARS;
  for (const p of [...latest.values()].sort((a, b) => b.index - a.index)) {
    if (p.size > budget) continue;
    budget -= p.size;
    pinned.add(p.callId);
  }
  return pinned;
}

export function compactHistory(history: Message[], info: CallInfo = () => ({})): Message[] {
  const toolIdx = history.map((m, i) => (m.role === 'tool' ? i : -1)).filter((i) => i >= 0);
  const keepFrom = toolIdx.length > KEEP_LAST_RESULTS ? (toolIdx[toolIdx.length - KEEP_LAST_RESULTS] ?? 0) : 0;
  const pinned = pinnedCalls(history, info);
  return history.map((m, i) => {
    if (i === 0) return m;
    if (m.role === 'assistant') {
      const toolCalls: ToolCall[] = m.toolCalls.map((c) => ({ ...c, args: elide(c.args) }));
      const content = i < keepFrom && m.content.length > TEXT_LIMIT ? `${m.content.slice(0, TEXT_LIMIT)}...` : m.content;
      return { role: 'assistant', content, toolCalls };
    }
    if (m.role === 'tool' && i < keepFrom) {
      return {
        role: 'tool',
        results: m.results.map((r) => (pinned.has(r.callId) ? r : { ...r, content: r.content.length > RESULT_LIMIT ? `${firstLine(r.content)} (superseded or stale; fetch again only if needed)` : r.content })),
      };
    }
    return m;
  });
}
