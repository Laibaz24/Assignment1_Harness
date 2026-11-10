/**
 * Standard 04 - REST conventions. One unit per route:
 *  - versioned base path (/v1/...)
 *  - plural nouns for every static segment
 *  - collection GET: cursor pagination (cursor in query schema, nextCursor in response)
 *  - POST to a collection: 201 + Idempotency-Key support + 409 conflict path
 *  - DELETE: 204
 *  - item routes (/:id): a 404 path
 *  - 2xx statuses limited to 200/201/202/204
 */
import { Node, SyntaxKind } from 'ts-morph';
import { defineRule, resultFrom } from '../../core/plugin.ts';
import type { Finding, RouteInfo } from '../../core/types.ts';
import { chainRoot, expandedText, paramNames } from '../ast.ts';

const IRREGULAR_PLURALS = new Set(['people', 'children', 'data', 'media', 'metadata', 'men', 'women', 'feet', 'teeth', 'mice', 'criteria', 'series', 'news', 'analytics', 'indices', 'matrices']);

export function isPlural(segment: string): boolean {
  const word = segment.toLowerCase().split('-').pop() ?? '';
  if (IRREGULAR_PLURALS.has(word)) return true;
  return /[a-z]s$/.test(word) && !/(ss|us|is)$/.test(word);
}

function statusesUsed(r: RouteInfo): number[] {
  if (!r.handler) return [];
  const { res } = paramNames(r.handler);
  const out: number[] = [];
  for (const call of r.handler.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    if (!Node.isPropertyAccessExpression(callee) || chainRoot(callee) !== res) continue;
    if (callee.getName() !== 'status' && callee.getName() !== 'sendStatus') continue;
    const a = call.getArguments()[0];
    if (a && Node.isNumericLiteral(a)) out.push(Number(a.getLiteralValue()));
  }
  return out;
}

export default defineRule({
  id: 'rest-conventions',
  category: 'standard',
  description: 'Plural nouns, versioned base path, cursor pagination, idempotency keys, consistent 201/204/404/409/422.',
  run(ctx) {
    const units: Finding[] = [];
    const detail: Finding[] = [];
    for (const r of ctx.routes) {
      const label = `${r.method.toUpperCase()} ${r.path}`;
      const issues: string[] = [];
      const segments = r.path.split('/').filter(Boolean);
      const [version, ...rest] = segments;
      if (!version || !/^v\d+$/.test(version)) issues.push('path is not under a versioned base (/v1/...)');
      const statics = rest.filter((s) => !s.startsWith(':'));
      for (const s of statics) if (!isPlural(s)) issues.push(`segment "${s}" is not a plural noun`);
      if (rest.length === 0) issues.push('no resource segment after the version');
      const isItem = (rest[rest.length - 1] ?? '').startsWith(':');
      const isCollection = rest.length > 0 && !isItem;
      const text = expandedText(r.handler);
      const statuses = statusesUsed(r);
      for (const s of statuses) if (s >= 200 && s < 300 && ![200, 201, 202, 204].includes(s)) issues.push(`unusual success status ${s}`);

      if (r.method === 'get' && isCollection) {
        if (!/\bcursor\b/.test(text)) issues.push('collection GET has no cursor query parameter');
        if (!/\bnextCursor\b/.test(text)) issues.push('collection GET response has no nextCursor');
      }
      if (r.method === 'post' && isCollection) {
        if (!statuses.includes(201)) issues.push('POST to a collection must respond 201');
        if (!/idempotency-key/i.test(text)) issues.push('POST does not honour an Idempotency-Key header');
        if (!/\b409\b|\bconflict\s*\(/.test(text)) issues.push('POST has no 409 conflict path (duplicate / idempotency mismatch)');
      }
      if (r.method === 'delete' && !statuses.includes(204)) issues.push('DELETE must respond 204');
      if (isItem && !/\b404\b|\bnotFound\s*\(/.test(text)) issues.push('item route has no 404 path');

      if (issues.length === 0) {
        const f = { file: r.file, line: r.line, ok: true, message: label };
        units.push(f);
        detail.push(f);
      } else {
        const fs = issues.map((i) => ({ file: r.file, line: r.line, ok: false, message: `${label}: ${i}` }));
        units.push(...fs.slice(0, 1));
        detail.push(...fs);
      }
    }
    return { ...resultFrom('routes', units), findings: detail };
  },
});
