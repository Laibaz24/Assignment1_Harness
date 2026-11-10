/**
 * Extensibility: a tool, an ORM validator and a linter rule are added by dropping
 * one file each into src/registry/** - no core file changes - and show up on the
 * next registry load / standards check.
 */
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runCheck } from '../../src/checks/engine.ts';
import { HARNESS_ROOT, loadRegistry, REGISTRY_DIR } from '../../src/core/registry.ts';

const TOOL = join(REGISTRY_DIR, 'tools', 'zz-test-openapi-diff.ts');
const LINTER = join(REGISTRY_DIR, 'linters', 'zz-test-no-todo.ts');

afterAll(() => {
  rmSync(TOOL, { force: true });
  rmSync(LINTER, { force: true });
});

describe('registry', () => {
  it('ships the example plugins', async () => {
    const reg = await loadRegistry();
    expect(reg.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['api_map', 'read_file', 'write_file', 'run_tests', 'finish', 'contract_status']));
    expect(reg.rules.map((r) => r.id)).toEqual(expect.arrayContaining(['no-console', 'orm-explicit-select']));
  });

  it('picks up a dropped-in tool and linter on the next load', async () => {
    writeFileSync(
      TOOL,
      `import { z } from 'zod';\nimport { defineTool } from '../../core/plugin.ts';\nexport default defineTool({ name: 'openapi_diff', description: 'test', kind: 'read', schema: z.object({}), run: async () => ({ summary: 'ok' }) });\n`,
    );
    writeFileSync(
      LINTER,
      `import { defineLinter, resultFrom } from '../../core/plugin.ts';\nexport default defineLinter({ id: 'no-todo', description: 'no TODO', run: (ctx) => resultFrom('files', ctx.sourceFiles.map((sf) => ({ file: ctx.rel(sf.getFilePath()), ok: !sf.getFullText().includes('TODO'), message: 'TODO found' }))) });\n`,
    );
    const reg = await loadRegistry();
    expect(reg.tools.map((t) => t.name)).toContain('openapi_diff');
    const report = await runCheck(join(HARNESS_ROOT, 'tests', 'fixtures', 'sample-api'), { runtime: false, extraRules: reg.rules });
    expect(report.text).toMatch(/no-todo\s+pass\s+\d+\/\d+ files/);
    expect(report.text).toMatch(/orm-explicit-select\s+n\/a/);
  }, 120_000);
});
