/**
 * Example linter plugin: no console.* calls in API source (use a logger or stdout).
 * Dropping this file here is all it takes: it joins `harness check` with its own
 * pass/fail line and file:line locations. No core file changes.
 */
import { Node, SyntaxKind } from 'ts-morph';
import { defineLinter, resultFrom } from '../../core/plugin.ts';
import type { Finding } from '../../core/types.ts';

export default defineLinter({
  id: 'no-console',
  description: 'No console.* calls in src/',
  run(ctx) {
    const findings: Finding[] = [];
    for (const sf of ctx.sourceFiles) {
      const file = ctx.rel(sf.getFilePath());
      const hits = sf.getDescendantsOfKind(SyntaxKind.CallExpression).filter((c) => {
        const callee = c.getExpression();
        return Node.isPropertyAccessExpression(callee) && callee.getExpression().getText() === 'console';
      });
      if (hits.length === 0) findings.push({ file, ok: true, message: 'clean' });
      for (const h of hits) findings.push({ file, line: h.getStartLineNumber(), ok: false, message: `console call: ${h.getText().slice(0, 60)}` });
    }
    return resultFrom('files', findings);
  },
});
