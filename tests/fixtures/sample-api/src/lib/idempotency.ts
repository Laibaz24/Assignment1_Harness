/**
 * Idempotency keys for unsafe retries. Harness-owned scaffold.
 * POST handlers parse headers with IdempotencyHeadersSchema and wrap creation in
 * store.run(key, body, create). Same key + same body replays the first result;
 * same key + different body is a 409 conflict.
 */
import { z } from 'zod';
import { conflict } from './problem';

export const IdempotencyHeadersSchema = z.object({
  'idempotency-key': z.string().min(8).max(255).optional(),
});
export type IdempotencyHeaders = z.infer<typeof IdempotencyHeadersSchema>;

export function createIdempotencyStore<T>() {
  const seen = new Map<string, { fingerprint: string; value: T }>();
  return {
    async run(key: string | undefined, payload: unknown, produce: () => T | Promise<T>): Promise<{ value: T; replayed: boolean }> {
      if (key === undefined) return { value: await produce(), replayed: false };
      const fingerprint = JSON.stringify(payload);
      const previous = seen.get(key);
      if (previous !== undefined) {
        if (previous.fingerprint !== fingerprint) throw conflict('Idempotency-Key was already used with a different request body');
        return { value: previous.value, replayed: true };
      }
      const value = await produce();
      seen.set(key, { fingerprint, value });
      return { value, replayed: false };
    },
  };
}
