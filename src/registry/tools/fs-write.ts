/**
 * Write tools. They declare their target path and a preview of the resulting
 * content so the pre-write hooks (path guard, secret scan, observed red, escape
 * hatches) can block BEFORE anything touches disk.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { defineTool } from '../../core/plugin.ts';

const norm = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '');

function persist(abs: string, content: string): void {
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

const writeFileTool = defineTool({
  name: 'write_file',
  description: 'Create or overwrite a workspace file with the full content given.',
  kind: 'write',
  schema: z.object({ path: z.string().min(1), content: z.string() }),
  writes: ({ path }) => norm(path),
  preview: ({ content }) => content,
  async run({ path, content }, ctx) {
    const rel = norm(path);
    const abs = ctx.services.resolveInWorkspace(rel);
    const existed = existsSync(abs);
    persist(abs, content);
    ctx.state.writtenFiles.add(rel);
    return { summary: `${existed ? 'overwrote' : 'created'} ${rel} (${content.split('\n').length} lines)` };
  },
});

function applyEdit(current: string, oldText: string, newText: string): { ok: true; next: string } | { ok: false; error: string } {
  const count = current.split(oldText).length - 1;
  if (count === 0) return { ok: false, error: 'oldText not found (it must match the file exactly, including whitespace)' };
  if (count > 1) return { ok: false, error: `oldText matches ${count} times; include more surrounding lines to make it unique` };
  return { ok: true, next: current.replace(oldText, () => newText) };
}

const editFileTool = defineTool({
  name: 'edit_file',
  description: 'Replace one exact, unique occurrence of oldText with newText in a workspace file.',
  kind: 'write',
  schema: z.object({ path: z.string().min(1), oldText: z.string().min(1), newText: z.string() }),
  writes: ({ path }) => norm(path),
  preview: ({ path, oldText, newText }, ctx) => {
    const abs = ctx.services.resolveInWorkspace(norm(path));
    const current = existsSync(abs) ? readFileSync(abs, 'utf8') : '';
    const r = applyEdit(current, oldText, newText);
    return r.ok ? r.next : current;
  },
  async run({ path, oldText, newText }, ctx) {
    const rel = norm(path);
    const abs = ctx.services.resolveInWorkspace(rel);
    if (!existsSync(abs)) return { summary: `no such file: ${rel}`, isError: true };
    const r = applyEdit(readFileSync(abs, 'utf8'), oldText, newText);
    if (!r.ok) return { summary: `edit_file ${rel}: ${r.error}`, isError: true };
    persist(abs, r.next);
    ctx.state.writtenFiles.add(rel);
    const removed = oldText.split('\n').length;
    const added = newText.split('\n').length;
    return { summary: `edited ${rel}: -${removed} +${added} lines` };
  },
});

export default [writeFileTool, editFileTool];
