/** Built-in hooks, in execution order. Extra hooks are dropped into src/registry/hooks. */
import type { HookDef } from '../core/types.ts';
import escapeHatches from './escape-hatches.ts';
import observedRed from './observed-red.ts';
import pathGuard from './path-guard.ts';
import secretScan from './secret-scan.ts';
import typecheckOnWrite from './typecheck-on-write.ts';

export const BUILTIN_HOOKS: HookDef[] = [pathGuard, secretScan, observedRed, escapeHatches, typecheckOnWrite];
