/**
 * Task loading and workspace preparation. Deterministic: the scaffold, the brownfield
 * copy and the protected-file list are produced by code, not by the model.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { HARNESS_ROOT } from './registry.ts';
import { toPosix } from './runner.ts';
import type { TaskFile } from './types.ts';

const FieldSchema = z.object({
  name: z.string().regex(/^[a-z][a-zA-Z0-9]*$/),
  type: z.enum(['string', 'email', 'integer', 'number', 'boolean', 'enum', 'datetime', 'uuid']),
  required: z.boolean().optional(),
  unique: z.boolean().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  values: z.array(z.string()).optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

/** Task files are provider-neutral by construction: unknown keys (e.g. "model", "provider") are rejected. */
export const TaskFileSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  mode: z.enum(['greenfield', 'brownfield']),
  target: z.string().min(1),
  source: z.string().optional(),
  goal: z.string().min(1),
  resource: z.object({ name: z.string(), plural: z.string(), fields: z.array(FieldSchema).min(1) }).optional(),
  behaviours: z.array(z.string()).min(1),
  allowBreaking: z.array(z.string()).optional(),
});

export function loadTask(path: string): TaskFile {
  const abs = isAbsolute(path) ? path : resolve(process.cwd(), path);
  const parsed = TaskFileSchema.safeParse(parseYaml(readFileSync(abs, 'utf8')));
  if (!parsed.success) {
    throw new Error(`invalid task file ${path}:\n${parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')}`);
  }
  const t = parsed.data;
  if (t.mode === 'brownfield' && !t.source) throw new Error(`invalid task file ${path}: brownfield tasks need "source"`);
  if (t.mode === 'greenfield' && !t.resource) throw new Error(`invalid task file ${path}: greenfield tasks need "resource"`);
  const task: TaskFile = { id: t.id, mode: t.mode, target: t.target, goal: t.goal, behaviours: t.behaviours };
  if (t.source !== undefined) task.source = t.source;
  if (t.resource !== undefined) task.resource = t.resource;
  if (t.allowBreaking !== undefined) task.allowBreaking = t.allowBreaking;
  return task;
}

export const MARKER = '.harness-workspace.json';
export const TEMPLATE_DIR = join(HARNESS_ROOT, 'templates', 'express-zod');
const SKIP = new Set(['node_modules', '.git', 'dist', 'coverage']);

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Refuse to wipe anything the harness did not create. Never damage a repository. */
function assertOwned(target: string): void {
  if (!isInside(HARNESS_ROOT, target) || target === HARNESS_ROOT) throw new Error(`target ${target} must be a sub-directory of the harness root`);
  if (!existsSync(target)) return;
  const entries = readdirSync(target);
  if (entries.length === 0 || entries.includes(MARKER)) return;
  throw new Error(`target ${target} exists and was not created by the harness (no ${MARKER}); refusing to overwrite`);
}

export function listFiles(root: string, sub = ''): string[] {
  const dir = join(root, sub);
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (SKIP.has(name)) continue;
    const rel = sub ? `${sub}/${name}` : name;
    if (statSync(join(root, rel)).isDirectory()) out.push(...listFiles(root, rel));
    else out.push(rel);
  }
  return out;
}

export interface PreparedWorkspace {
  dir: string;
  protectedFiles: Set<string>;
}

export function prepareWorkspace(task: TaskFile, runId: string, outOverride?: string): PreparedWorkspace {
  const dir = resolve(HARNESS_ROOT, outOverride ?? task.target);
  assertOwned(dir);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const protectedFiles = new Set<string>(['package.json', 'tsconfig.json', 'package-lock.json', MARKER]);
  if (task.mode === 'greenfield') {
    cpSync(TEMPLATE_DIR, dir, { recursive: true });
    // Harness-owned scaffold library: the model uses it, it may not rewrite it.
    for (const f of listFiles(dir, 'src/lib')) protectedFiles.add(f);
  } else {
    const src = resolve(HARNESS_ROOT, task.source ?? '');
    if (!existsSync(src)) throw new Error(`brownfield source ${src} does not exist`);
    cpSync(src, dir, { recursive: true, filter: (p) => !p.split(sep).some((part) => SKIP.has(part)) });
  }
  writeFileSync(join(dir, MARKER), JSON.stringify({ createdBy: 'ts-api-harness', task: task.id, runId, at: new Date().toISOString() }, null, 2) + '\n');
  return { dir, protectedFiles };
}

/** Resolve a model-supplied relative path inside the workspace, or throw. */
export function resolveInside(workspace: string, rel: string): string {
  const abs = resolve(workspace, rel);
  if (!isInside(workspace, abs)) throw new Error(`path escapes workspace: ${rel}`);
  return abs;
}

export const relPosix = (root: string, abs: string): string => toPosix(relative(root, abs));
