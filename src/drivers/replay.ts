/**
 * Replay driver: plays a scripted sequence of tool calls through the real loop,
 * hooks and checks. Not a model. Used for offline end-to-end tests and CI, and to
 * demonstrate that the gates fire (scripts deliberately include refused writes).
 *
 * Script (YAML):
 *   steps:
 *     - say: optional assistant text
 *       calls:
 *         - { tool: write_file, args: { path: tests/x.test.ts }, contentFrom: users-api/tests/x.test.ts }
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { CompletionRequest, CompletionResponse, Driver, TokenCount } from '../core/types.ts';
import { estimateTokens } from './estimate.ts';

const CallSchema = z.object({
  tool: z.string(),
  args: z.record(z.string(), z.unknown()).default({}),
  contentFrom: z.string().optional(),
  newTextFrom: z.string().optional(),
});
const ScriptSchema = z.object({ steps: z.array(z.object({ say: z.string().optional(), calls: z.array(CallSchema).min(1) })) });

export class ReplayDriver implements Driver {
  readonly label = 'replay';
  readonly model = 'scripted-replay';
  private readonly steps: z.infer<typeof ScriptSchema>['steps'];
  private readonly baseDir: string;
  private cursor = 0;

  constructor(scriptPath: string) {
    this.steps = ScriptSchema.parse(parseYaml(readFileSync(scriptPath, 'utf8'))).steps;
    this.baseDir = dirname(resolve(scriptPath));
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const step = this.steps[this.cursor];
    this.cursor++;
    const usage = { inputTokens: estimateTokens(req), outputTokens: 0 };
    if (!step) return { text: 'replay script exhausted', toolCalls: [], usage, stop: 'end' };
    const toolCalls = step.calls.map((c, i) => {
      const args: Record<string, unknown> = { ...c.args };
      if (c.contentFrom) args['content'] = readFileSync(resolve(this.baseDir, c.contentFrom), 'utf8');
      if (c.newTextFrom) args['newText'] = readFileSync(resolve(this.baseDir, c.newTextFrom), 'utf8');
      return { id: `replay_${this.cursor}_${i}`, name: c.tool, args };
    });
    usage.outputTokens = estimateTokens({ system: '', tools: [], maxOutputTokens: 0, messages: [{ role: 'assistant', content: step.say ?? '', toolCalls }] });
    return { text: step.say ?? '', toolCalls, usage, stop: 'tools' };
  }

  async countTokens(req: CompletionRequest): Promise<TokenCount> {
    return { tokens: estimateTokens(req), method: 'local-tokenizer-estimate' };
  }
}
