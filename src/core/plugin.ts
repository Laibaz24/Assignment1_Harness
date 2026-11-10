/**
 * Public plugin API. Plugins in src/registry/** import only from this file.
 * The define* helpers are identity functions that give plugin authors type checking.
 */
import type { z } from 'zod';
import type { Finding, HookDef, RuleDef, RuleResult, ToolDef } from './types.ts';

export type * from './types.ts';

export function defineTool<S extends z.ZodType>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

export function defineHook(def: HookDef): HookDef {
  return def;
}

/** A standards rule. Use category 'lint' for linter rules, 'orm' for ORM validators. */
export function defineRule(def: RuleDef): RuleDef {
  return def;
}

export const defineLinter = (def: Omit<RuleDef, 'category'>): RuleDef => ({ ...def, category: 'lint' });
export const defineValidator = (def: Omit<RuleDef, 'category'>): RuleDef => ({ ...def, category: 'orm' });

/** Helper for rules: build a RuleResult from per-unit findings. Zero units = n/a (nothing to check), never pass-by-default. */
export function resultFrom(unit: string, findings: Finding[], note?: string): RuleResult {
  const total = findings.length;
  const passed = findings.filter((f) => f.ok).length;
  const status = total === 0 ? 'n/a' : passed === total ? 'pass' : 'fail';
  return note === undefined ? { status, unit, passed, total, findings } : { status, unit, passed, total, findings, note };
}
