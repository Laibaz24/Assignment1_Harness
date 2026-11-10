/**
 * Standard 02 - RFC 7807 errors, nothing else (static half).
 * Units = error paths: every throw / next(err) site, plus the problem writer and
 * the error middleware. Ad-hoc error statuses and { error: ... } bodies fail.
 */
import { Node, SyntaxKind, type SourceFile } from 'ts-morph';
import { defineRule, resultFrom } from '../../core/plugin.ts';
import type { Finding } from '../../core/types.ts';
import { chainRoot, isProblemType } from '../ast.ts';

const CT = 'application/problem+json';
const FIELDS = ['type', 'title', 'status', 'detail', 'instance'];

function isProblemModule(sf: SourceFile): boolean {
  return sf.getFullText().includes(CT);
}

export default defineRule({
  id: 'problem-json',
  category: 'standard',
  description: 'Every non-2xx response is application/problem+json with type, title, status, detail, instance.',
  run(ctx) {
    const findings: Finding[] = [];
    const problemModules = ctx.sourceFiles.filter(isProblemModule);

    if (problemModules.length === 0) {
      findings.push({ file: 'src', ok: false, message: `no module writes ${CT} responses` });
    }
    for (const sf of problemModules) {
      const file = ctx.rel(sf.getFilePath());
      const text = sf.getFullText();
      const missing = FIELDS.filter((f) => !new RegExp(`\\b${f}\\s*:`).test(text));
      findings.push({ file, line: 1, ok: missing.length === 0, message: missing.length ? `problem writer missing fields: ${missing.join(', ')}` : 'problem writer emits type,title,status,detail,instance' });
      const errMw = sf.getDescendantsOfKind(SyntaxKind.ArrowFunction).some((f) => f.getParameters().length === 4)
        || sf.getDescendantsOfKind(SyntaxKind.FunctionDeclaration).some((f) => f.getParameters().length === 4)
        || /ErrorRequestHandler/.test(text);
      findings.push({ file, line: 1, ok: errMw, message: errMw ? 'error middleware converts thrown errors to problems' : 'no 4-arity error middleware found' });
      const validation = /ZodError/.test(text) && /422/.test(text);
      findings.push({ file, line: 1, ok: validation, message: validation ? 'ZodError -> 422 problem' : 'ZodError is not mapped to a 422 problem' });
    }

    for (const sf of ctx.sourceFiles) {
      const file = ctx.rel(sf.getFilePath());
      const inProblemModule = isProblemModule(sf);

      for (const th of sf.getDescendantsOfKind(SyntaxKind.ThrowStatement)) {
        const ex = th.getExpression();
        const ok = isProblemType(ex.getType());
        findings.push({ file, line: th.getStartLineNumber(), ok, message: ok ? `throws problem: ${ex.getText().slice(0, 60)}` : `throws non-problem error (would surface as a generic 500): ${ex.getText().slice(0, 60)}` });
      }

      for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const callee = call.getExpression();
        const arg0 = call.getArguments()[0];
        // next(err) inside middleware
        if (Node.isIdentifier(callee) && callee.getText() === 'next' && arg0) {
          const ok = isProblemType(arg0.getType());
          findings.push({ file, line: call.getStartLineNumber(), ok, message: ok ? `next(problem): ${arg0.getText().slice(0, 60)}` : `next() with non-problem error: ${arg0.getText().slice(0, 60)}` });
          continue;
        }
        if (!Node.isPropertyAccessExpression(callee) || inProblemModule) continue;
        const name = callee.getName();
        const root = chainRoot(callee);
        if (root === undefined) continue;
        if ((name === 'status' || name === 'sendStatus') && arg0) {
          const lit = Node.isNumericLiteral(arg0) ? Number(arg0.getLiteralValue()) : undefined;
          if (lit === undefined) {
            findings.push({ file, line: call.getStartLineNumber(), ok: false, message: `${root}.${name}(${arg0.getText()}) status is not a literal; error statuses must go through the problem helper` });
          } else if (lit >= 300) {
            findings.push({ file, line: call.getStartLineNumber(), ok: false, message: `ad-hoc ${lit} response outside the problem helper` });
          }
        }
        if ((name === 'json' || name === 'send') && arg0 && Node.isObjectLiteralExpression(arg0)) {
          const keys = arg0.getProperties().map((p) => (Node.isPropertyAssignment(p) || Node.isShorthandPropertyAssignment(p) ? p.getName() : ''));
          if (keys.includes('error') || keys.includes('errors') || keys.includes('message')) {
            findings.push({ file, line: call.getStartLineNumber(), ok: false, message: `ad-hoc error body { ${keys.join(', ')} }` });
          }
        }
      }
    }
    return resultFrom('error paths', findings);
  },
});
