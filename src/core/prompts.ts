/**
 * Prompt text. Deliberately small: rules live in hooks and checks (they cost zero
 * tokens until they fire), details are fetched on demand with read_standard / api_map.
 * Provider-neutral plain text; no vendor prompt formats.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { HARNESS_ROOT } from './registry.ts';
import type { TaskFile } from './types.ts';
import { listFiles } from './workspace.ts';

export const STANDARDS_DOC = join(HARNESS_ROOT, 'docs', 'standards.md');

export function systemPrompt(task: TaskFile): string {
  return [
    'You work inside a harness that governs TypeScript REST API code (Express + Zod). You have no shell and no git; use the tools.',
    `Mode: ${task.mode}. All paths are relative to the workspace root.`,
    'Enforced by hooks and checks - violations are refused, not warned:',
    '1. Test first. A file under src/ can only be written after a test covering it (a line "// @covers src/<file>.ts", or same basename .test.ts) was run with run_tests and seen FAILING.',
    '2. Zod parses every req.params/query/body/headers and every response body (Schema.parse). Types come from z.infer, never hand-written.',
    '3. Errors are RFC 7807 problem+json: throw notFound()/conflict()/badRequest() from src/lib/problem.ts; never res.status(4xx/5xx) yourself.',
    '4. No `any`, no non-null `!`, no @ts-ignore. tsc runs strict + noUncheckedIndexedAccess.',
    '5. REST: /v1 base path, plural nouns, cursor pagination on lists, Idempotency-Key on POST, 201 create, 204 delete, 404, 409, 422.',
    task.mode === 'brownfield' ? '6. Do not break the existing contract (routes, statuses, request/response schemas); the harness diffs it.' : '6. src/lib, package.json and tsconfig.json are harness-owned: use them, do not rewrite them.',
    'Context is fetched just in time: start with api_map, then outline/read_file with line ranges; read_standard(<id>) for rule details.',
    'Your latest read of each file stays in the conversation until that file changes: never re-read it. Read what you need once, then write.',
    'Call finish when done. The harness then runs all tests and standards checks; the task ends only when they are green.',
  ].join('\n');
}

export function taskBrief(task: TaskFile): string {
  const lines = [`Task ${task.id}: ${task.goal}`];
  if (task.resource) {
    lines.push(`Resource: ${task.resource.name} (collection "${task.resource.plural}")`);
    for (const f of task.resource.fields) {
      const extra = [
        f.required ? 'required' : 'optional',
        f.unique ? 'unique' : '',
        f.min !== undefined ? `min ${f.min}` : '',
        f.max !== undefined ? `max ${f.max}` : '',
        f.values ? `values ${f.values.join('|')}` : '',
        f.default !== undefined ? `default ${String(f.default)}` : '',
      ].filter(Boolean);
      lines.push(`  - ${f.name}: ${f.type} (${extra.join(', ')})`);
    }
  }
  lines.push('Behaviours:', ...task.behaviours.map((b) => `  - ${b}`));
  if (task.allowBreaking?.length) lines.push(`Contract changes allowed: ${task.allowBreaking.join(', ')}`);
  return lines.join('\n');
}

/**
 * Baseline context = what a harness without JIT fetchers would front-load:
 * every workspace file plus the full standards document, at session start.
 */
export function frontLoadedContext(workspace: string): string {
  const parts: string[] = ['', '=== FULL STANDARDS DOCUMENT ===', existsSync(STANDARDS_DOC) ? readFileSync(STANDARDS_DOC, 'utf8') : '', '', '=== FULL REPOSITORY CONTENTS ==='];
  for (const f of listFiles(workspace)) {
    const abs = join(workspace, f);
    if (statSync(abs).size > 200_000) continue;
    parts.push(`--- ${f} ---`, readFileSync(abs, 'utf8'));
  }
  return parts.join('\n');
}

export function standardsSection(id: string): string {
  if (!existsSync(STANDARDS_DOC)) return 'standards document missing';
  const doc = readFileSync(STANDARDS_DOC, 'utf8');
  const sections = doc.split(/^## /m).slice(1);
  const hit = sections.find((s) => s.split('\n')[0]?.trim().toLowerCase() === id.trim().toLowerCase());
  if (!hit) return `unknown standard "${id}". Available: ${sections.map((s) => s.split('\n')[0]?.trim()).join(', ')}`;
  return `## ${hit.trim()}`;
}
