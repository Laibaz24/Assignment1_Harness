/**
 * Example ORM validator plugin: every Prisma or Drizzle query on users must select
 * explicit columns (no `SELECT *` leaking password hashes into responses).
 *   Drizzle: db.select().from(users)            -> FAIL   db.select({ id: users.id }).from(users) -> pass
 *   Prisma:  prisma.user.findMany({ where })    -> FAIL   prisma.user.findMany({ select: {...} }) -> pass
 * APIs without ORM queries on users report n/a (nothing to check), not pass.
 */
import { Node, SyntaxKind } from 'ts-morph';
import { defineValidator, resultFrom } from '../../core/plugin.ts';
import type { Finding } from '../../core/types.ts';

const TABLE = /^users?$/i;
const PRISMA_READS = new Set(['findMany', 'findFirst', 'findFirstOrThrow', 'findUnique', 'findUniqueOrThrow', 'create', 'update', 'upsert', 'delete']);

export default defineValidator({
  id: 'orm-explicit-select',
  description: 'Prisma/Drizzle queries on users select explicit columns',
  run(ctx) {
    const findings: Finding[] = [];
    for (const sf of ctx.sourceFiles) {
      const file = ctx.rel(sf.getFilePath());
      for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const callee = call.getExpression();
        if (!Node.isPropertyAccessExpression(callee)) continue;
        const line = call.getStartLineNumber();
        // Drizzle: <x>.select(...).from(users)
        if (callee.getName() === 'from' && TABLE.test(call.getArguments()[0]?.getText() ?? '')) {
          const inner = callee.getExpression();
          if (Node.isCallExpression(inner)) {
            const innerCallee = inner.getExpression();
            if (Node.isPropertyAccessExpression(innerCallee) && innerCallee.getName() === 'select') {
              const ok = inner.getArguments().length > 0;
              findings.push({ file, line, ok, message: ok ? 'drizzle select on users has explicit columns' : 'drizzle select() on users without explicit columns' });
            }
          }
        }
        // Prisma: prisma.user.findMany({...})
        const model = callee.getExpression();
        if (PRISMA_READS.has(callee.getName()) && Node.isPropertyAccessExpression(model) && TABLE.test(model.getName())) {
          const arg = call.getArguments()[0];
          const ok = arg !== undefined && Node.isObjectLiteralExpression(arg) && arg.getProperty('select') !== undefined;
          findings.push({ file, line, ok, message: ok ? `prisma ${model.getName()}.${callee.getName()} selects explicit columns` : `prisma ${model.getName()}.${callee.getName()} without select` });
        }
      }
    }
    return resultFrom('queries', findings, findings.length === 0 ? 'no Prisma/Drizzle queries on users' : undefined);
  },
});
