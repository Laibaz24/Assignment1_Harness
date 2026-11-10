/**
 * Standard 01 - Zod at every boundary.
 * Per handler: every read of req.params / req.query / req.body / req.headers / req.header()
 * is passed directly into Schema.parse(); path params, bodies of unsafe methods are parsed;
 * every res.json()/res.send() body is a Schema.parse(...) result.
 */
import { Node, SyntaxKind } from 'ts-morph';
import { defineRule, resultFrom } from '../../core/plugin.ts';
import type { Finding } from '../../core/types.ts';
import { chainRoot, isZodParseCall, isZodParsed, paramNames } from '../ast.ts';

const INPUTS = new Set(['params', 'query', 'body', 'headers', 'cookies']);
const HEADER_FNS = new Set(['header', 'get']);
const BODY_SENDERS = new Set(['json', 'send', 'jsonp']);

export default defineRule({
  id: 'zod-boundary',
  category: 'standard',
  description: 'Request params, query, body, headers and response bodies pass through Zod schemas.',
  run(ctx) {
    const units: Finding[] = [];
    const detail: Finding[] = [];
    for (const r of ctx.routes) {
      const where = { file: r.file, line: r.line };
      const label = `${r.method.toUpperCase()} ${r.path}`;
      if (!r.handler) {
        const f = { ...where, ok: false, message: `${label}: handler not statically resolvable` };
        units.push(f);
        detail.push(f);
        continue;
      }
      const { req, res } = paramNames(r.handler);
      const problems: { line: number; msg: string }[] = [];
      const parsed = new Set<string>();

      for (const pa of r.handler.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
        const obj = pa.getExpression();
        if (!Node.isIdentifier(obj) || obj.getText() !== req) continue;
        const name = pa.getName();
        const parent = pa.getParent();
        if (INPUTS.has(name)) {
          if (isZodParsed(pa)) parsed.add(name);
          else problems.push({ line: pa.getStartLineNumber(), msg: `${req}.${name} read without Zod parse` });
        } else if (HEADER_FNS.has(name) && parent && Node.isCallExpression(parent) && parent.getExpression() === pa) {
          if (isZodParsed(parent)) parsed.add('headers');
          else problems.push({ line: pa.getStartLineNumber(), msg: `${req}.${name}() read without Zod parse` });
        }
      }
      if (r.path.includes(':') && !parsed.has('params')) problems.push({ line: r.line, msg: 'path params not parsed with Zod' });
      if (['post', 'put', 'patch'].includes(r.method) && !parsed.has('body')) problems.push({ line: r.line, msg: 'request body not parsed with Zod' });

      let sends = 0;
      for (const call of r.handler.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const callee = call.getExpression();
        if (!Node.isPropertyAccessExpression(callee) || chainRoot(callee) !== res) continue;
        const name = callee.getName();
        if (BODY_SENDERS.has(name)) {
          const arg = call.getArguments()[0];
          if (arg === undefined) continue;
          sends++;
          if (!isZodParseCall(arg)) problems.push({ line: call.getStartLineNumber(), msg: `response body not produced by Schema.parse(): ${arg.getText().slice(0, 50)}` });
        } else if (name === 'end' || name === 'sendStatus') {
          sends++;
        }
      }
      if (sends === 0) problems.push({ line: r.line, msg: 'handler sends no response through the response object' });

      if (problems.length === 0) {
        const f = { ...where, ok: true, message: label };
        units.push(f);
        detail.push(f);
      } else {
        const fs = problems.map((p) => ({ file: r.file, line: p.line, ok: false, message: `${label}: ${p.msg}` }));
        units.push(...fs.slice(0, 1));
        detail.push(...fs);
      }
    }
    return { ...resultFrom('handlers', units), findings: detail };
  },
});
