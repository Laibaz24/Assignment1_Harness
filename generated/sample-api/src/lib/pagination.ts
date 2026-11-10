/**
 * Cursor pagination. Harness-owned scaffold.
 * List endpoints parse their query with a schema built from CursorQuerySchema and
 * respond with pageSchema(Item).parse(paginate(items, query)).
 */
import { z } from 'zod';
import { badRequest } from './problem';

export const CursorQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type CursorQuery = z.infer<typeof CursorQuerySchema>;

export function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({ data: z.array(item), nextCursor: z.string().nullable() });
}

export const encodeCursor = (id: string): string => Buffer.from(id, 'utf8').toString('base64url');

export function decodeCursor(cursor: string): string {
  const id = Buffer.from(cursor, 'base64url').toString('utf8');
  if (id.length === 0) throw badRequest('cursor is not valid');
  return id;
}

/** Items must be in a stable order; the cursor is the id of the last item returned. */
export function paginate<T extends { id: string }>(items: readonly T[], query: CursorQuery): { data: T[]; nextCursor: string | null } {
  let start = 0;
  if (query.cursor !== undefined) {
    const afterId = decodeCursor(query.cursor);
    const index = items.findIndex((item) => item.id === afterId);
    if (index === -1) throw badRequest('cursor does not match any item');
    start = index + 1;
  }
  const data = items.slice(start, start + query.limit);
  const last = data[data.length - 1];
  const hasMore = start + query.limit < items.length;
  return { data, nextCursor: hasMore && last !== undefined ? encodeCursor(last.id) : null };
}
