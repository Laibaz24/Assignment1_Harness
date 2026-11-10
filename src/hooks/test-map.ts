/**
 * Source -> test mapping. A test covers a source file when it declares
 * `// @covers src/path/file.ts`, or when its basename matches (users.test.ts <-> users.ts).
 * Deterministic: read from disk, never from the model's claims.
 */
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { listFiles } from '../core/workspace.ts';

export const isTestPath = (rel: string): boolean => /\.(test|spec)\.ts$/.test(rel);
export const isSourcePath = (rel: string): boolean => rel.startsWith('src/') && rel.endsWith('.ts') && !isTestPath(rel) && !rel.endsWith('.d.ts');

export function coversOf(content: string): string[] {
  return [...content.matchAll(/@covers\s+(\S+)/g)].map((m) => (m[1] ?? '').replace(/^\.\//, ''));
}

export function testsCovering(workspace: string, sourceRel: string): string[] {
  const stem = basename(sourceRel, '.ts');
  return listFiles(workspace)
    .filter(isTestPath)
    .filter((t) => {
      if (basename(t).replace(/\.(test|spec)\.ts$/, '') === stem) return true;
      return coversOf(readFileSync(join(workspace, t), 'utf8')).includes(sourceRel);
    });
}

/** Map of every source file to its covering tests (used by the api_map tool and the finish audit). */
export function sourceTestMap(workspace: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const s of listFiles(workspace).filter(isSourcePath)) map.set(s, testsCovering(workspace, s));
  return map;
}
