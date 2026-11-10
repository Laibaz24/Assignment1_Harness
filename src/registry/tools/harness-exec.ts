/**
 * Tools that ask the HARNESS to run something deterministic on the model's behalf.
 * The model never gets a shell: it can only request a test run or a standards check,
 * and gets pass/fail lines back. Raw logs go to disk and are referenced by path.
 */
import { z } from 'zod';
import { compactReport } from '../../checks/engine.ts';
import { defineTool } from '../../core/plugin.ts';

const runTestsTool = defineTool({
  name: 'run_tests',
  description: 'Run the workspace tests with the harness runner (records red/green). Optionally limit to some test files.',
  kind: 'exec',
  schema: z.object({ files: z.array(z.string()).optional() }),
  async run({ files }, ctx) {
    const r = await ctx.services.runTests(files);
    if (!r.ran) return { summary: `tests did not run: ${r.error ?? 'unknown'} (log: ${r.rawLogPath})`, isError: true };
    const lines = r.files.map((f) => `${f.status === 'pass' ? 'PASS' : 'FAIL'} ${f.file}${f.failures.length ? '\n  ' + f.failures.slice(0, 4).join('\n  ') : ''}`);
    return { summary: `${r.passed} passed, ${r.failed} failed\n${lines.join('\n')}`, raw: r.rawOutput };
  },
});

const runChecksTool = defineTool({
  name: 'run_checks',
  description: 'Run the API standards checks. Returns only failing lines plus the summary.',
  kind: 'exec',
  schema: z.object({}),
  async run(_args, ctx) {
    const report = await ctx.services.runChecks({ runtime: true });
    return { summary: compactReport(report), raw: report.text };
  },
});

const readStandardTool = defineTool({
  name: 'read_standard',
  description: 'Fetch one section of the API standards: zod-boundary, zod-infer, problem-json, strict-types, rest-conventions, contract-drift, testing, scaffold.',
  kind: 'read',
  schema: z.object({ id: z.string() }),
  contextKey: ({ id }) => `standard:${id}`,
  async run({ id }, ctx) {
    return { summary: ctx.services.standardsSection(id) };
  },
});

const finishTool = defineTool({
  name: 'finish',
  description: 'Declare the task complete. The harness then runs all gates; you are done only if they are green.',
  kind: 'control',
  schema: z.object({ summary: z.string().describe('one paragraph: what changed and why') }),
  async run({ summary }) {
    return { summary: `finish requested: ${summary.slice(0, 300)}` };
  },
});

export default [runTestsTool, runChecksTool, readStandardTool, finishTool];
