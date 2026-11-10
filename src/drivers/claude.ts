/**
 * Claude adapter. The ONLY place that knows Anthropic's message and tool formats.
 * Neutral Message[] / ToolSpec[] in, neutral CompletionResponse out.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { CompletionRequest, CompletionResponse, Driver, Message, TokenCount, ToolCall } from '../core/types.ts';
import { estimateTokens, withCost } from './estimate.ts';

type Block = Anthropic.Messages.ContentBlockParam;
type Param = Anthropic.Messages.MessageParam;

export function toAnthropic(messages: Message[]): Param[] {
  const out: Param[] = [];
  const push = (role: 'user' | 'assistant', blocks: Block[]): void => {
    const last = out[out.length - 1];
    // Anthropic requires alternating roles: merge consecutive same-role turns.
    if (last && last.role === role && Array.isArray(last.content)) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m.role === 'user') push('user', [{ type: 'text', text: m.content }]);
    else if (m.role === 'assistant') {
      const blocks: Block[] = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const c of m.toolCalls) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: (typeof c.args === 'object' && c.args !== null ? c.args : {}) as Record<string, unknown> });
      if (blocks.length === 0) blocks.push({ type: 'text', text: '(no content)' });
      push('assistant', blocks);
    } else {
      push('user', m.results.map((r) => ({ type: 'tool_result' as const, tool_use_id: r.callId, content: r.content, is_error: r.isError })));
    }
  }
  return out;
}

export class ClaudeDriver implements Driver {
  readonly label = 'claude';
  readonly model: string;
  readonly gateway: 'direct' | 'openrouter';
  private readonly client: Anthropic;
  private countEndpoint = true;

  /**
   * ANTHROPIC_API_KEY -> Anthropic directly. Otherwise OPENROUTER_API_KEY -> OpenRouter's
   * Anthropic-compatible endpoint (same Messages format, so this adapter is exercised as-is).
   */
  constructor(model?: string) {
    const direct = process.env['ANTHROPIC_API_KEY'];
    const routed = process.env['OPENROUTER_API_KEY'];
    if (direct) {
      this.gateway = 'direct';
      this.client = new Anthropic({ apiKey: direct, maxRetries: 4 });
      this.model = model ?? process.env['HARNESS_CLAUDE_MODEL'] ?? 'claude-sonnet-5-5';
    } else if (routed) {
      this.gateway = 'openrouter';
      this.client = new Anthropic({ baseURL: 'https://openrouter.ai/api', apiKey: null, authToken: routed, maxRetries: 4 });
      this.model = model ?? process.env['HARNESS_OPENROUTER_CLAUDE_MODEL'] ?? 'anthropic/claude-sonnet-5.5';
    } else {
      throw new Error('set ANTHROPIC_API_KEY or OPENROUTER_API_KEY (keys come from the environment only)');
    }
  }

  private params(req: CompletionRequest) {
    return {
      model: this.model,
      system: req.system,
      messages: toAnthropic(req.messages),
      tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: { ...t.parameters, type: 'object' as const } })),
    };
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const res = await this.client.messages.create({ ...this.params(req), max_tokens: req.maxOutputTokens });
    const toolCalls: ToolCall[] = [];
    let text = '';
    for (const block of res.content) {
      if (block.type === 'text') text += block.text;
      else if (block.type === 'tool_use') toolCalls.push({ id: block.id, name: block.name, args: block.input });
    }
    const u = res.usage;
    return {
      text,
      toolCalls,
      usage: withCost({ inputTokens: u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), outputTokens: u.output_tokens }, u),
      stop: res.stop_reason === 'tool_use' ? 'tools' : res.stop_reason === 'max_tokens' ? 'max_tokens' : 'end',
    };
  }

  async countTokens(req: CompletionRequest): Promise<TokenCount> {
    if (this.countEndpoint) {
      try {
        const res = await this.client.messages.countTokens(this.params(req));
        return { tokens: res.input_tokens, method: 'provider-count-endpoint' };
      } catch {
        this.countEndpoint = false; // gateway without a count endpoint: fall back, and say so in the report
      }
    }
    return { tokens: estimateTokens(req), method: 'local-tokenizer-estimate' };
  }
}
