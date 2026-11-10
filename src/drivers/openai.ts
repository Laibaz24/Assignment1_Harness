/**
 * OpenAI adapter. The ONLY place that knows OpenAI's chat + function-calling formats.
 */
import OpenAI from 'openai';
import type { CompletionRequest, CompletionResponse, Driver, Message, TokenCount, ToolCall } from '../core/types.ts';
import { estimateTokens, withCost } from './estimate.ts';

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export function toOpenAI(system: string, messages: Message[]): ChatMessage[] {
  const out: ChatMessage[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content });
    else if (m.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: m.content || null,
        ...(m.toolCalls.length
          ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } })) }
          : {}),
      });
    } else {
      for (const r of m.results) out.push({ role: 'tool', tool_call_id: r.callId, content: r.isError ? `ERROR: ${r.content}` : r.content });
    }
  }
  return out;
}

export class OpenAIDriver implements Driver {
  readonly label = 'openai';
  readonly model: string;
  readonly gateway: 'direct' | 'openrouter';
  private readonly client: OpenAI;

  /** OPENAI_API_KEY -> OpenAI directly. Otherwise OPENROUTER_API_KEY -> OpenRouter's OpenAI-compatible endpoint. */
  constructor(model?: string) {
    const direct = process.env['OPENAI_API_KEY'];
    const routed = process.env['OPENROUTER_API_KEY'];
    if (direct) {
      this.gateway = 'direct';
      this.client = new OpenAI({ apiKey: direct, maxRetries: 4 });
      this.model = model ?? process.env['HARNESS_OPENAI_MODEL'] ?? 'gpt-5';
    } else if (routed) {
      this.gateway = 'openrouter';
      this.client = new OpenAI({ apiKey: routed, baseURL: 'https://openrouter.ai/api/v1', maxRetries: 4 });
      this.model = model ?? process.env['HARNESS_OPENROUTER_OPENAI_MODEL'] ?? 'openai/gpt-5.5';
    } else {
      throw new Error('set OPENAI_API_KEY or OPENROUTER_API_KEY (keys come from the environment only)');
    }
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const res = await this.client.chat.completions.create({
      model: this.model,
      messages: toOpenAI(req.system, req.messages),
      tools: req.tools.map((t) => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.parameters } })),
      max_completion_tokens: req.maxOutputTokens,
    });
    const choice = res.choices[0];
    const toolCalls: ToolCall[] = [];
    for (const c of choice?.message.tool_calls ?? []) {
      if (c.type !== 'function') continue;
      let args: unknown = {};
      try {
        args = JSON.parse(c.function.arguments || '{}');
      } catch {
        args = { __unparseable: c.function.arguments };
      }
      toolCalls.push({ id: c.id, name: c.function.name, args });
    }
    return {
      text: choice?.message.content ?? '',
      toolCalls,
      usage: withCost({ inputTokens: res.usage?.prompt_tokens ?? 0, outputTokens: res.usage?.completion_tokens ?? 0 }, res.usage),
      stop: choice?.finish_reason === 'tool_calls' ? 'tools' : choice?.finish_reason === 'length' ? 'max_tokens' : 'end',
    };
  }

  async countTokens(req: CompletionRequest): Promise<TokenCount> {
    return { tokens: estimateTokens(req), method: 'local-tokenizer-estimate' };
  }
}
