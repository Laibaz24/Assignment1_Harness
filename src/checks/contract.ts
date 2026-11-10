/**
 * Contract snapshots and breaking-change diff (the harness's own addition:
 * the contract-drift gate). A contract is derived from code, not written by hand:
 * routes + success statuses come from the AST, request/response shapes come from
 * the Zod schemas the handlers actually parse with, converted to JSON Schema.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Node, SyntaxKind } from 'ts-morph';
import { z } from 'zod';
import { nodeTs } from '../core/exec.ts';
import { HARNESS_ROOT } from '../core/registry.ts';
import type { Finding, RouteInfo } from '../core/types.ts';
import { chainRoot, paramNames, PARSE_METHODS } from './ast.ts';

export type Part = 'params' | 'query' | 'body' | 'headers' | 'response';
const PARTS: Part[] = ['params', 'query', 'body', 'headers', 'response'];

export interface RouteContract {
  statuses: number[];
  schemas: Partial<Record<Part, unknown>>;
}
export interface Contract {
  generatedAt: string;
  routes: Record<string, RouteContract>;
}

export const ContractSchema = z.object({
  generatedAt: z.string(),
  routes: z.record(z.string(), z.object({ statuses: z.array(z.number()), schemas: z.record(z.string(), z.unknown()) })),
});

interface Ref { id: string; file: string; name: string; io: 'input' | 'output' }

function schemaRef(callee: Node): { file: string; name: string } | undefined {
  if (!Node.isPropertyAccessExpression(callee) || !PARSE_METHODS.has(callee.getName())) return undefined;
  const obj = callee.getExpression();
  if (!Node.isIdentifier(obj)) return undefined;
  for (const d of obj.getDefinitionNodes()) {
    if (Node.isVariableDeclaration(d) && d.isExported()) return { file: d.getSourceFile().getFilePath(), name: d.getName() };
  }
  return undefined;
}

export const routeKey = (r: Pick<RouteInfo, 'method' | 'path'>): string => `${r.method.toUpperCase()} ${r.path}`;

export async function extractContract(routes: RouteInfo[]): Promise<Contract> {
  const refs: Ref[] = [];
  const contract: Contract = { generatedAt: new Date().toISOString(), routes: {} };
  for (const r of routes) {
    const key = routeKey(r);
    const rc: RouteContract = { statuses: [], schemas: {} };
    contract.routes[key] = rc;
    if (!r.handler) continue;
    const { req, res } = paramNames(r.handler);
    for (const call of r.handler.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression();
      const arg = call.getArguments()[0];
      // Schema.parse(req.body) etc.
      if (arg && Node.isPropertyAccessExpression(arg) && Node.isIdentifier(arg.getExpression()) && arg.getExpression().getText() === req) {
        const part = arg.getName() as Part;
        const ref = PARTS.includes(part) ? schemaRef(callee) : undefined;
        if (ref) refs.push({ id: `${key}|${part}`, ...ref, io: 'input' });
        else if (PARTS.includes(part)) rc.schemas[part] = { unresolved: 'schema is not an exported const' };
      }
      // res.json(Schema.parse(x)) / res.status(201)
      if (Node.isPropertyAccessExpression(callee) && chainRoot(callee) === res) {
        const name = callee.getName();
        if ((name === 'status' || name === 'sendStatus') && arg && Node.isNumericLiteral(arg)) {
          const s = Number(arg.getLiteralValue());
          if (s < 300 && !rc.statuses.includes(s)) rc.statuses.push(s);
        }
        if ((name === 'json' || name === 'send') && arg && Node.isCallExpression(arg)) {
          const ref = schemaRef(arg.getExpression());
          if (ref) refs.push({ id: `${key}|response`, ...ref, io: 'output' });
        }
      }
    }
    if (rc.statuses.length === 0) rc.statuses.push(200);
    rc.statuses.sort();
  }
  if (refs.length > 0) {
    const tmp = mkdtempSync(join(tmpdir(), 'harness-contract-'));
    try {
      const refsFile = join(tmp, 'refs.json');
      writeFileSync(refsFile, JSON.stringify(refs));
      const out = await nodeTs(join(HARNESS_ROOT, 'src', 'checks', 'runtime', 'contract-dump.ts'), [refsFile], { timeoutMs: 60_000 });
      let dumped: Record<string, unknown> = {};
      try {
        dumped = z.record(z.string(), z.unknown()).parse(JSON.parse(out.stdout));
      } catch {
        dumped = {};
      }
      for (const ref of refs) {
        const [key, part] = ref.id.split('|') as [string, Part];
        const rc = contract.routes[key];
        if (rc) rc.schemas[part] = dumped[ref.id] ?? { unresolved: 'schema dump failed' };
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  return contract;
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;
const asObj = (x: unknown): Json | undefined => (typeof x === 'object' && x !== null && !Array.isArray(x) ? (x as Json) : undefined);
const strArr = (x: unknown): string[] => (Array.isArray(x) ? x.filter((v): v is string => typeof v === 'string') : []);
const typeOf = (s: Json): string => JSON.stringify(s['type'] ?? (s['anyOf'] ? 'anyOf' : s['enum'] ? 'enum' : s['const'] !== undefined ? 'const' : 'any'));

/** Returns human-readable breaking changes from `before` to `after` for one schema. */
export function breakingChanges(before: unknown, after: unknown, dir: 'request' | 'response', at: string): string[] {
  const b = asObj(before);
  const a = asObj(after);
  if (!b || 'unresolved' in b) return [];
  if (!a) return [`${at}: schema removed`];
  if ('unresolved' in a) return [`${at}: schema can no longer be resolved (${String(a['unresolved'])})`];
  const out: string[] = [];
  if (typeOf(b) !== typeOf(a)) return [`${at}: type changed ${typeOf(b)} -> ${typeOf(a)}`];
  const be = strArr(b['enum']);
  const ae = strArr(a['enum']);
  if (be.length || ae.length) {
    if (dir === 'request') for (const v of be) if (!ae.includes(v)) out.push(`${at}: enum value "${v}" no longer accepted`);
    if (dir === 'response') for (const v of ae) if (!be.includes(v)) out.push(`${at}: new enum value "${v}" may break clients`);
  }
  if (b['anyOf'] || a['anyOf']) {
    if (JSON.stringify(b['anyOf']) !== JSON.stringify(a['anyOf'])) out.push(`${at}: union changed`);
  }
  if (dir === 'request') {
    for (const k of ['minLength', 'minimum', 'minItems'] as const) {
      const bv = b[k], av = a[k];
      if (typeof av === 'number' && (typeof bv !== 'number' || av > bv)) out.push(`${at}: ${k} tightened to ${av}`);
    }
    for (const k of ['maxLength', 'maximum', 'maxItems'] as const) {
      const bv = b[k], av = a[k];
      if (typeof av === 'number' && (typeof bv !== 'number' || av < bv)) out.push(`${at}: ${k} tightened to ${av}`);
    }
    if (a['pattern'] !== b['pattern'] && a['pattern'] !== undefined) out.push(`${at}: pattern changed`);
    if (a['format'] !== b['format'] && a['format'] !== undefined) out.push(`${at}: format changed to ${String(a['format'])}`);
  }
  const bp = asObj(b['properties']);
  const ap = asObj(a['properties']);
  if (bp || ap) {
    const breq = strArr(b['required']);
    const areq = strArr(a['required']);
    for (const k of Object.keys(bp ?? {})) {
      if (!ap || !(k in ap)) out.push(`${at}.${k}: field removed`);
      else out.push(...breakingChanges(bp?.[k], ap[k], dir, `${at}.${k}`));
      if (dir === 'response' && breq.includes(k) && !areq.includes(k) && ap && k in ap) out.push(`${at}.${k}: no longer always present`);
    }
    if (dir === 'request') for (const k of areq) if (!breq.includes(k)) out.push(`${at}.${k}: new required field`);
  }
  if (b['items'] || a['items']) out.push(...breakingChanges(b['items'], a['items'], dir, `${at}[]`));
  return out;
}

export function diffContracts(before: Contract, after: Contract, allow: string[] = []): { findings: Finding[]; additive: string[] } {
  const findings: Finding[] = [];
  const additive: string[] = [];
  for (const [key, b] of Object.entries(before.routes)) {
    const a = after.routes[key];
    const breaking: string[] = [];
    if (!a) breaking.push('route removed');
    else {
      for (const s of b.statuses) if (!a.statuses.includes(s)) breaking.push(`success status ${s} no longer returned`);
      for (const part of PARTS) {
        breaking.push(...breakingChanges(b.schemas[part], a.schemas[part], part === 'response' ? 'response' : 'request', part));
      }
      if (JSON.stringify(a.schemas) !== JSON.stringify(b.schemas) && breaking.length === 0) additive.push(`${key}: compatible schema change`);
    }
    const allowed = allow.includes(key);
    if (breaking.length === 0) findings.push({ file: 'contract', ok: true, message: `${key}: compatible` });
    else for (const br of breaking) findings.push({ file: 'contract', ok: allowed, message: `${key}: ${br}${allowed ? ' (allowed by task)' : ''}` });
  }
  for (const key of Object.keys(after.routes)) if (!before.routes[key]) additive.push(`${key}: new route`);
  return { findings, additive };
}
