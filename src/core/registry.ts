/**
 * Plugin discovery. Every *.ts file under src/registry/<kind>/ is loaded on each run.
 * Adding a tool, ORM validator, linter rule or hook = dropping one file there.
 * Files starting with "_" are ignored (use for shared helpers or disabling a plugin).
 */
import { readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { HookDef, RuleDef, ToolDef } from './types.ts';

export const HARNESS_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const REGISTRY_DIR = join(HARNESS_ROOT, 'src', 'registry');

export interface Registry {
  tools: ToolDef[];
  rules: RuleDef[];
  hooks: HookDef[];
  sources: { kind: string; file: string; names: string[] }[];
}

type Kind = 'tools' | 'validators' | 'linters' | 'hooks';

async function loadKind(kind: Kind): Promise<{ file: string; defs: unknown[] }[]> {
  const dir = join(REGISTRY_DIR, kind);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts') && !f.startsWith('_'))
    .sort();
  const out: { file: string; defs: unknown[] }[] = [];
  for (const f of files) {
    const mod = (await import(pathToFileURL(join(dir, f)).href)) as { default?: unknown };
    if (mod.default === undefined) throw new Error(`registry/${kind}/${f}: missing default export`);
    out.push({ file: `src/registry/${kind}/${f}`, defs: Array.isArray(mod.default) ? mod.default : [mod.default] });
  }
  return out;
}

function isTool(x: unknown): x is ToolDef {
  return typeof x === 'object' && x !== null && 'name' in x && 'schema' in x && 'run' in x && 'kind' in x;
}
function isRule(x: unknown): x is RuleDef {
  return typeof x === 'object' && x !== null && 'id' in x && 'category' in x && 'run' in x;
}
function isHook(x: unknown): x is HookDef {
  return typeof x === 'object' && x !== null && 'name' in x && 'phase' in x && 'appliesTo' in x && 'run' in x;
}

export async function loadRegistry(): Promise<Registry> {
  const reg: Registry = { tools: [], rules: [], hooks: [], sources: [] };
  for (const kind of ['tools', 'validators', 'linters', 'hooks'] as const) {
    for (const { file, defs } of await loadKind(kind)) {
      const names: string[] = [];
      for (const d of defs) {
        if (kind === 'tools' && isTool(d)) { reg.tools.push(d); names.push(d.name); }
        else if ((kind === 'validators' || kind === 'linters') && isRule(d)) { reg.rules.push(d); names.push(d.id); }
        else if (kind === 'hooks' && isHook(d)) { reg.hooks.push(d); names.push(d.name); }
        else throw new Error(`${file}: default export is not a valid ${kind.slice(0, -1)} definition`);
      }
      reg.sources.push({ kind, file, names });
    }
  }
  const dup = reg.tools.map((t) => t.name).filter((n, i, a) => a.indexOf(n) !== i);
  if (dup.length) throw new Error(`duplicate tool names in registry: ${dup.join(', ')}`);
  return reg;
}
