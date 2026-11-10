/**
 * api_map: the brownfield scoping fetcher. One compact table instead of the repo:
 * every route (method, path, file:line), every source file with its covering tests,
 * and the exported helpers of src/lib.
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { extractRoutes, isTestFile, loadProject } from '../../checks/ast.ts';
import { defineTool } from '../../core/plugin.ts';
import { relPosix } from '../../core/workspace.ts';
import { sourceTestMap } from '../../hooks/test-map.ts';

export default defineTool({
  name: 'api_map',
  description: 'Compact map of the API: routes, source files with their covering tests, scaffold helper exports. Start here.',
  kind: 'read',
  schema: z.object({}),
  contextKey: () => 'api_map',
  async run(_args, ctx) {
    const ws = ctx.state.workspace;
    const project = loadProject(ws);
    const files = project.getSourceFiles().filter((sf) => {
      const rel = relPosix(ws, sf.getFilePath());
      return rel.startsWith('src/') && !isTestFile('/' + rel);
    });
    const routes = extractRoutes(files, (f) => relPosix(ws, f));
    const map = sourceTestMap(ws);
    const lib = [...map.keys()].filter((f) => f.startsWith('src/lib/'));
    const libExports = lib.map((f) => {
      const names = [...readFileSync(ctx.services.resolveInWorkspace(f), 'utf8').matchAll(/^export (?:const|function|class|type) (\w+)/gm)].map((m) => m[1]);
      return `  ${f}: ${names.join(', ')}`;
    });
    const out = [
      `routes (${routes.length}):`,
      ...routes.map((r) => `  ${r.method.toUpperCase().padEnd(6)} ${r.path}  ${r.file}:${r.line}`),
      'source -> covering tests:',
      ...[...map.entries()].filter(([f]) => !f.startsWith('src/lib/')).map(([f, t]) => `  ${f} -> ${t.length ? t.join(', ') : '(none)'}`),
      'scaffold helpers (read-only):',
      ...(libExports.length ? libExports : ['  (none)']),
    ];
    return { summary: out.join('\n') };
  },
});
