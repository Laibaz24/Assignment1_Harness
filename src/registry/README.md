# Registry: drop-in plugins

Every `*.ts` file in these folders is loaded on each run (files starting with `_` are ignored). Adding a plugin never requires touching `src/core`, `src/drivers`, `src/hooks` or `src/checks`.

## Tool: `tools/<name>.ts`

```ts
import { z } from 'zod';
import { defineTool } from '../../core/plugin.ts';

export default defineTool({
  name: 'openapi_diff',
  description: 'Diff the generated OpenAPI document against main.',
  kind: 'read',                       // read | write | exec | control
  schema: z.object({ base: z.string().optional() }),
  async run({ base }, ctx) {
    // ctx.state.workspace, ctx.services.log(name, raw) -> path
    return { summary: 'compact result the model sees', raw: 'full output, written to disk' };
  },
});
```

Write tools also declare `writes(args)` (target path) and `preview(args, ctx)` (resulting content) so pre-hooks can block before disk is touched.

## ORM validator: `validators/<name>.ts`

```ts
import { defineValidator, resultFrom } from '../../core/plugin.ts';

export default defineValidator({
  id: 'orm-explicit-select',
  description: 'Queries on users select explicit columns',
  run(ctx) {                            // ctx.sourceFiles (ts-morph), ctx.routes, ctx.rel(path)
    return resultFrom('queries', [{ file: 'src/db.ts', line: 12, ok: false, message: 'select() without columns' }]);
  },
});
```

## Linter rule: `linters/<name>.ts`

Same shape with `defineLinter`. The rule gets its own line in `harness check`, one line per file with `pass` or `FAIL file:line message`, and counts toward the verdict. A rule with nothing to check returns `n/a`, which is never reported as pass.

## Hook: `hooks/<name>.ts`

```ts
import { defineHook } from '../../core/plugin.ts';

export default defineHook({
  name: 'no-new-deps',
  phase: 'pre',
  appliesTo: (tool) => tool.kind === 'write',
  run: (ev) => (ev.path === 'package.json' ? { decision: 'block', feedback: 'dependencies are harness-owned' } : { decision: 'pass' }),
});
```
