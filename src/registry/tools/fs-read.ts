/**
 * JIT context fetchers: list_files, read_file (line ranges), search, outline.
 * Each returns a compact summary; in baseline mode (fetchers disabled) read_file
 * returns whole files and search returns every hit.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { z } from 'zod';
import { defineTool } from '../../core/plugin.ts';
import { listFiles } from '../../core/workspace.ts';

const MAX_LINES = 200;
const norm = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '');

const listFilesTool = defineTool({
  name: 'list_files',
  description: 'List workspace files (optionally under a sub-directory) with line counts.',
  kind: 'read',
  schema: z.object({ dir: z.string().optional().describe('workspace-relative directory, default root') }),
  async run({ dir }, ctx) {
    const root = ctx.state.workspace;
    const files = listFiles(root, dir ?? '').filter((f) => !f.startsWith('.harness'));
    const lines = files.map((f) => {
      const abs = ctx.services.resolveInWorkspace(f);
      const n = statSync(abs).size < 400_000 ? readFileSync(abs, 'utf8').split('\n').length : -1;
      return `${f} (${n} lines)`;
    });
    return { summary: lines.length ? lines.join('\n') : '(no files)' };
  },
});

const readFileTool = defineTool({
  name: 'read_file',
  description: `Read a workspace file with line numbers. Use startLine/endLine; at most ${MAX_LINES} lines per call.`,
  kind: 'read',
  schema: z.object({ path: z.string(), startLine: z.number().int().min(1).optional(), endLine: z.number().int().min(1).optional() }),
  contextKey: ({ path, startLine, endLine }) => `file:${norm(path)}:${startLine ?? 1}-${endLine ?? 'end'}`,
  async run({ path, startLine, endLine }, ctx) {
    const abs = ctx.services.resolveInWorkspace(path);
    if (!existsSync(abs)) return { summary: `no such file: ${path}`, isError: true };
    const all = readFileSync(abs, 'utf8').split('\n');
    const numbered = (from: number, to: number): string => all.slice(from - 1, to).map((l, i) => `${String(from + i).padStart(4)}| ${l}`).join('\n');
    if (ctx.baseline) return { summary: numbered(1, all.length) };
    const from = startLine ?? 1;
    const to = Math.min(endLine ?? from + MAX_LINES - 1, from + MAX_LINES - 1, all.length);
    const more = to < all.length ? `\n... ${all.length - to} more lines (read_file with startLine=${to + 1})` : '';
    return { summary: `${path} lines ${from}-${to} of ${all.length}\n${numbered(from, to)}${more}` };
  },
});

const searchTool = defineTool({
  name: 'search',
  description: 'Regex search across workspace files. Returns file:line: text hits (max 30).',
  kind: 'read',
  schema: z.object({ pattern: z.string().min(1), dir: z.string().optional() }),
  async run({ pattern, dir }, ctx) {
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch (e) {
      return { summary: `invalid regex: ${String(e)}`, isError: true };
    }
    const hits: string[] = [];
    for (const f of listFiles(ctx.state.workspace, dir ?? '')) {
      const text = readFileSync(ctx.services.resolveInWorkspace(f), 'utf8');
      text.split('\n').forEach((line, i) => {
        if (re.test(line)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 160)}`);
      });
    }
    const limit = ctx.baseline ? hits.length : 30;
    const shown = hits.slice(0, limit);
    return { summary: shown.length ? shown.join('\n') + (hits.length > limit ? `\n... ${hits.length - limit} more hits` : '') : 'no matches', raw: hits.join('\n') };
  },
});

const outlineTool = defineTool({
  name: 'outline',
  description: 'Exported symbols of a TypeScript file with their first line - cheaper than reading the file.',
  kind: 'read',
  schema: z.object({ path: z.string() }),
  contextKey: ({ path }) => `file:${norm(path)}:outline`,
  async run({ path }, ctx) {
    const abs = ctx.services.resolveInWorkspace(path);
    if (!existsSync(abs)) return { summary: `no such file: ${path}`, isError: true };
    const lines = readFileSync(abs, 'utf8').split('\n');
    const out = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => /^export\s/.test(l))
      .map(({ l, i }) => `${String(i + 1).padStart(4)}| ${l.trim().slice(0, 180)}`);
    return { summary: `${path} exports:\n${out.join('\n') || '(none)'}` };
  },
});

export default [listFilesTool, readFileTool, searchTool, outlineTool];
