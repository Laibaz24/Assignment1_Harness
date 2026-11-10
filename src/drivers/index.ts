/** Driver factory. Selected by the --driver CLI flag only; task files never name a provider or model. */
import type { Driver } from '../core/types.ts';
import { ClaudeDriver } from './claude.ts';
import { OpenAIDriver } from './openai.ts';
import { ReplayDriver } from './replay.ts';

export const DRIVER_NAMES = ['claude', 'openai', 'replay'] as const;
export type DriverName = (typeof DRIVER_NAMES)[number];

export function createDriver(name: string, opts: { model?: string; script?: string } = {}): Driver {
  switch (name) {
    case 'claude':
      return new ClaudeDriver(opts.model);
    case 'openai':
      return new OpenAIDriver(opts.model);
    case 'replay':
      if (!opts.script) throw new Error('--driver replay needs --script <file>');
      return new ReplayDriver(opts.script);
    default:
      throw new Error(`unknown driver "${name}" (expected one of: ${DRIVER_NAMES.join(', ')})`);
  }
}
