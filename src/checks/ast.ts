/**
 * Shared static analysis used by the standards checks and by the pre-write hooks.
 * Everything here is deterministic AST work with ts-morph: no model involved.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Node, Project, SyntaxKind, type SourceFile, type Type } from 'ts-morph';
import { toPosix } from '../core/runner.ts';
import type { RouteInfo } from '../core/types.ts';

export const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);
export const PARSE_METHODS = new Set(['parse', 'safeParse', 'parseAsync', 'safeParseAsync']);

export function isTestFile(path: string): boolean {
  const p = toPosix(path);
  return /\.(test|spec)\.ts$/.test(p) || p.includes('/tests/') || p.includes('/__tests__/');
}

export function loadProject(apiDir: string): Project {
  const tsconfig = join(apiDir, 'tsconfig.json');
  const project = existsSync(tsconfig)
    ? new Project({ tsConfigFilePath: tsconfig, skipAddingFilesFromTsConfig: true })
    : new Project({ compilerOptions: { strict: true, noUncheckedIndexedAccess: true } });
  project.addSourceFilesAtPaths([
    toPosix(join(apiDir, 'src', '**', '*.ts')),
    toPosix(join(apiDir, 'tests', '**', '*.ts')),
    '!' + toPosix(join(apiDir, '**', 'node_modules', '**')),
  ]);
  return project;
}

// ---------------------------------------------------------------------------
// Escape hatches (no any, no non-null assertion, no ts-ignore)
// ---------------------------------------------------------------------------

export interface Hit {
  line: number;
  message: string;
}

export function scanEscapeHatches(sf: SourceFile): Hit[] {
  const hits: Hit[] = [];
  for (const n of sf.getDescendantsOfKind(SyntaxKind.AnyKeyword)) hits.push({ line: n.getStartLineNumber(), message: 'explicit `any`' });
  for (const n of sf.getDescendantsOfKind(SyntaxKind.NonNullExpression)) hits.push({ line: n.getStartLineNumber(), message: `non-null assertion \`${n.getText().slice(0, 40)}\`` });
  sf.getFullText()
    .split('\n')
    .forEach((text, i) => {
      if (/(\/\/|\/\*).*@ts-(ignore|nocheck|expect-error)/.test(text)) hits.push({ line: i + 1, message: 'type-check suppression comment' });
    });
  return hits.sort((a, b) => a.line - b.line);
}

/** Parse in-memory content (used by pre-write hooks before a file touches disk). */
export function scanContent(fileName: string, content: string): Hit[] {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { strict: true } });
  return scanEscapeHatches(project.createSourceFile(fileName, content));
}

// ---------------------------------------------------------------------------
// Route extraction for Express-style routers: router.get('/v1/x', handler)
// and router.route('/v1/x').get(handler). Mount prefixes from app.use('/p', r).
// ---------------------------------------------------------------------------

function literalText(n: Node | undefined): string | undefined {
  if (n && (Node.isStringLiteral(n) || Node.isNoSubstitutionTemplateLiteral(n))) return n.getLiteralText();
  return undefined;
}

export type FunctionLike = import('ts-morph').ArrowFunction | import('ts-morph').FunctionExpression | import('ts-morph').FunctionDeclaration;

export function resolveFunction(n: Node | undefined, depth = 0): FunctionLike | undefined {
  if (!n || depth > 4) return undefined;
  if (Node.isArrowFunction(n) || Node.isFunctionExpression(n) || Node.isFunctionDeclaration(n)) return n;
  if (Node.isIdentifier(n)) {
    for (const d of n.getDefinitionNodes()) {
      if (Node.isFunctionDeclaration(d)) return d;
      if (Node.isVariableDeclaration(d)) return resolveFunction(d.getInitializer(), depth + 1);
    }
  }
  if (Node.isCallExpression(n)) {
    const args = n.getArguments();
    return resolveFunction(args[args.length - 1], depth + 1);
  }
  return undefined;
}

function chainedRoutePath(expr: Node): string | undefined {
  let cur: Node = expr;
  for (let i = 0; i < 8; i++) {
    if (!Node.isCallExpression(cur)) return undefined;
    const callee = cur.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) return undefined;
    if (callee.getName() === 'route') return literalText(cur.getArguments()[0]);
    cur = callee.getExpression();
  }
  return undefined;
}

function mountPrefixes(files: SourceFile[]): Map<string, string> {
  const prefixes = new Map<string, string>();
  for (const sf of files) {
    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression();
      if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== 'use') continue;
      const [first, second] = call.getArguments();
      const prefix = literalText(first);
      if (!prefix || !second) continue;
      const target = Node.isCallExpression(second) ? second.getExpression() : second;
      if (!Node.isIdentifier(target)) continue;
      for (const d of target.getDefinitionNodes()) prefixes.set(d.getSourceFile().getFilePath(), prefix);
    }
  }
  return prefixes;
}

const joinPath = (a: string, b: string): string => ('/' + [a, b].join('/').split('/').filter(Boolean).join('/')).replace(/\/$/, '') || '/';

export function extractRoutes(files: SourceFile[], rel: (f: string) => string): RouteInfo[] {
  const prefixes = mountPrefixes(files);
  const routes: RouteInfo[] = [];
  for (const sf of files) {
    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression();
      if (!Node.isPropertyAccessExpression(callee)) continue;
      const method = callee.getName();
      if (!HTTP_METHODS.has(method)) continue;
      const args = call.getArguments();
      let path = literalText(args[0]);
      let handlerArgs = args.slice(1);
      if (path === undefined) {
        path = chainedRoutePath(callee.getExpression());
        handlerArgs = args;
      }
      if (path === undefined || !path.startsWith('/') || handlerArgs.length === 0) continue;
      const handler = resolveFunction(handlerArgs[handlerArgs.length - 1]);
      routes.push({
        method: method as RouteInfo['method'],
        path: joinPath(prefixes.get(sf.getFilePath()) ?? '', path),
        file: rel(sf.getFilePath()),
        line: call.getStartLineNumber(),
        handler,
        handlerText: handler?.getText() ?? '',
      });
    }
  }
  return routes;
}

export function paramNames(fn: FunctionLike): { req?: string; res?: string } {
  const [p0, p1] = fn.getParameters();
  const out: { req?: string; res?: string } = {};
  if (p0) out.req = p0.getName();
  if (p1) out.res = p1.getName();
  return out;
}

/** Root identifier of a chain like res.status(201).location(x).json(y) -> "res". */
export function chainRoot(n: Node): string | undefined {
  let cur: Node = n;
  for (let i = 0; i < 12; i++) {
    if (Node.isIdentifier(cur)) return cur.getText();
    if (Node.isPropertyAccessExpression(cur)) cur = cur.getExpression();
    else if (Node.isCallExpression(cur)) cur = cur.getExpression();
    else if (Node.isAwaitExpression(cur) || Node.isParenthesizedExpression(cur)) cur = cur.getExpression();
    else return undefined;
  }
  return undefined;
}

/** Is `n` passed directly as the first argument of X.parse(...) / X.safeParse(...)? */
export function isZodParsed(n: Node): boolean {
  let child: Node = n;
  let parent = n.getParent();
  while (parent && (Node.isParenthesizedExpression(parent) || Node.isAsExpression(parent))) {
    child = parent;
    parent = parent.getParent();
  }
  if (!parent || !Node.isCallExpression(parent)) return false;
  if (parent.getArguments()[0] !== child) return false;
  const callee = parent.getExpression();
  return Node.isPropertyAccessExpression(callee) && PARSE_METHODS.has(callee.getName());
}

export function isZodParseCall(n: Node | undefined): boolean {
  if (!n) return false;
  const inner = Node.isAwaitExpression(n) || Node.isParenthesizedExpression(n) ? n.getExpression() : n;
  if (!Node.isCallExpression(inner)) return false;
  const callee = inner.getExpression();
  return Node.isPropertyAccessExpression(callee) && PARSE_METHODS.has(callee.getName());
}

export function isProblemType(t: Type): boolean {
  return ['status', 'title', 'detail'].every((p) => t.getProperty(p) !== undefined);
}

/**
 * Handler text plus the declarations it references, a few levels deep. Lets the
 * convention checks see that ListQuery = CursorQuerySchema.extend(...) has a cursor.
 */
export function expandedText(root: Node | undefined, depth = 3, budget = 60): string {
  if (!root) return '';
  const seen = new Set<Node>();
  const parts: string[] = [root.getText()];
  let frontier: Node[] = [root];
  for (let d = 0; d < depth && budget > 0; d++) {
    const next: Node[] = [];
    for (const node of frontier) {
      for (const id of node.getDescendantsOfKind(SyntaxKind.Identifier)) {
        if (budget <= 0) break;
        let defs: Node[] = [];
        try {
          defs = id.getDefinitionNodes();
        } catch {
          defs = [];
        }
        for (const def of defs) {
          if (seen.has(def) || def.getSourceFile().isDeclarationFile() || def.getSourceFile().getFilePath().includes('/node_modules/')) continue;
          seen.add(def);
          budget--;
          parts.push(def.getText());
          next.push(def);
        }
      }
    }
    frontier = next;
  }
  return parts.join('\n');
}
