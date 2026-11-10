/**
 * Standard 01 (second half) - TypeScript types are inferred from Zod schemas,
 * never hand-written a second time. Every interface / object-shaped type alias
 * under src/ fails; aliases derived via z.infer / z.input / z.output / typeof pass.
 */
import { SyntaxKind } from 'ts-morph';
import { defineRule, resultFrom } from '../../core/plugin.ts';
import type { Finding } from '../../core/types.ts';

const DERIVED = /\bz\.(infer|input|output)<|\btypeof\b|ReturnType<|Parameters<|Awaited</;

export default defineRule({
  id: 'zod-infer',
  category: 'standard',
  description: 'Types come from z.infer<typeof Schema>; no hand-written duplicate interfaces or object types.',
  run(ctx) {
    const findings: Finding[] = [];
    for (const sf of ctx.sourceFiles) {
      const file = ctx.rel(sf.getFilePath());
      for (const i of sf.getDescendantsOfKind(SyntaxKind.InterfaceDeclaration)) {
        findings.push({ file, line: i.getStartLineNumber(), ok: false, message: `interface ${i.getName()} is hand-written; derive it with z.infer<typeof Schema>` });
      }
      for (const t of sf.getDescendantsOfKind(SyntaxKind.TypeAliasDeclaration)) {
        const text = t.getTypeNode()?.getText() ?? '';
        const ok = DERIVED.test(text);
        findings.push({ file, line: t.getStartLineNumber(), ok, message: ok ? `type ${t.getName()} derived` : `type ${t.getName()} = ${text.slice(0, 40)} is hand-written; derive it from a schema` });
      }
    }
    return resultFrom('types', findings);
  },
});
