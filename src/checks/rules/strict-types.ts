/**
 * Standard 03 - Strict type safety (source half).
 * No `any`, no non-null assertions, no @ts-ignore / @ts-expect-error / @ts-nocheck,
 * in source and test files. One unit per file.
 */
import { defineRule, resultFrom } from '../../core/plugin.ts';
import type { Finding } from '../../core/types.ts';
import { scanEscapeHatches } from '../ast.ts';

export default defineRule({
  id: 'strict-types',
  category: 'standard',
  description: 'No any, no non-null assertions, no ts-ignore in generated code.',
  run(ctx) {
    const units: Finding[] = [];
    const detail: Finding[] = [];
    for (const sf of [...ctx.sourceFiles, ...ctx.testFiles]) {
      const file = ctx.rel(sf.getFilePath());
      const hits = scanEscapeHatches(sf);
      if (hits.length === 0) {
        const f = { file, ok: true, message: 'clean' };
        units.push(f);
        detail.push(f);
      } else {
        const fs = hits.map((h) => ({ file, line: h.line, ok: false, message: h.message }));
        units.push(...fs.slice(0, 1));
        detail.push(...fs);
      }
    }
    return { ...resultFrom('files', units), findings: detail };
  },
});
