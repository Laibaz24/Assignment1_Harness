/** Local token estimate (o200k tokenizer) for drivers without a count endpoint. Labelled as an estimate in every report. */
import { encode } from 'gpt-tokenizer';
import type { CompletionRequest, Usage } from '../core/types.ts';

/** Gateways (e.g. OpenRouter) report per-call cost in USD inside the usage object; keep it when present. */
export function withCost(usage: Usage, raw: unknown): Usage {
  const cost = typeof raw === 'object' && raw !== null && 'cost' in raw ? (raw as { cost: unknown }).cost : undefined;
  return typeof cost === 'number' ? { ...usage, costUsd: cost } : usage;
}

const PER_MESSAGE_OVERHEAD = 4;

export function estimateTokens(req: CompletionRequest): number {
  let n = encode(req.system).length + PER_MESSAGE_OVERHEAD;
  for (const t of req.tools) n += encode(JSON.stringify(t)).length;
  for (const m of req.messages) {
    n += PER_MESSAGE_OVERHEAD;
    if (m.role === 'user') n += encode(m.content).length;
    else if (m.role === 'assistant') n += encode(m.content).length + m.toolCalls.reduce((s, c) => s + encode(c.name + JSON.stringify(c.args)).length, 0);
    else n += m.results.reduce((s, r) => s + encode(r.content).length + PER_MESSAGE_OVERHEAD, 0);
  }
  return n;
}
