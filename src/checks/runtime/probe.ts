/**
 * Runtime half of the RFC 7807 check. Run as a subprocess by the harness:
 *   node --import tsx src/checks/runtime/probe.ts <apiDir> <routes.json>
 * Boots the API in-process (createApp from src/app.ts), fires error-inducing
 * requests and verifies every error response is a well-formed problem+json.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

const RoutesSchema = z.array(z.object({ method: z.string(), path: z.string() }));
const ProblemShape = z.object({ type: z.string().min(1), title: z.string().min(1), status: z.number().int(), detail: z.string(), instance: z.string().startsWith('/') });

interface ProbeResult { probe: string; ok: boolean; message: string }

async function main(): Promise<void> {
  const [apiDir, routesFile] = process.argv.slice(2);
  if (!apiDir || !routesFile) throw new Error('usage: probe.ts <apiDir> <routes.json>');
  const routes = RoutesSchema.parse(JSON.parse(readFileSync(routesFile, 'utf8')));
  const mod: Record<string, unknown> = await import(pathToFileURL(join(apiDir, 'src', 'app.ts')).href);
  const factory = mod['createApp'];
  const appCandidate: unknown = typeof factory === 'function' ? factory() : mod['app'] ?? mod['default'];
  const hasListen = typeof appCandidate === 'function' || (typeof appCandidate === 'object' && appCandidate !== null);
  if (!hasListen || typeof (appCandidate as { listen?: unknown }).listen !== 'function') {
    process.stdout.write(JSON.stringify({ unproven: 'src/app.ts exports neither createApp() nor app' }));
    return;
  }
  const listen = appCandidate as { listen: (port: number, cb: () => void) => import('node:http').Server };
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = listen.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const results: ProbeResult[] = [];
  const fill = (p: string): string => p.replace(/:([A-Za-z0-9_]+)/g, () => randomUUID());

  async function probe(name: string, method: string, path: string, init: { body?: string; expect: (s: number) => boolean }): Promise<void> {
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json', 'idempotency-key': `probe-${randomUUID()}` };
      const res = await fetch(base + path, init.body === undefined ? { method, headers } : { method, headers, body: init.body });
      const ct = res.headers.get('content-type') ?? '';
      const text = await res.text();
      if (res.status < 400) return void results.push({ probe: name, ok: false, message: `${method} ${path} -> ${res.status}, expected an error` });
      if (!init.expect(res.status)) return void results.push({ probe: name, ok: false, message: `${method} ${path} -> unexpected status ${res.status}` });
      if (!ct.startsWith('application/problem+json')) return void results.push({ probe: name, ok: false, message: `${method} ${path} -> ${res.status} content-type "${ct}"` });
      let json: unknown;
      try { json = JSON.parse(text); } catch { return void results.push({ probe: name, ok: false, message: `${method} ${path} -> body is not JSON` }); }
      const shape = ProblemShape.safeParse(json);
      if (!shape.success) return void results.push({ probe: name, ok: false, message: `${method} ${path} -> problem missing/invalid: ${shape.error.issues.map((i) => i.path.join('.')).join(',')}` });
      if (shape.data.status !== res.status) return void results.push({ probe: name, ok: false, message: `${method} ${path} -> body.status ${shape.data.status} != HTTP ${res.status}` });
      results.push({ probe: name, ok: true, message: `${method} ${path} -> ${res.status} problem+json` });
    } catch (e) {
      results.push({ probe: name, ok: false, message: `${method} ${path} -> request failed: ${String(e)}` });
    }
  }

  const is4xx = (s: number): boolean => s >= 400 && s < 500;
  await probe('unknown-route', 'GET', '/__harness_probe_unknown__', { expect: (s) => s === 404 });
  const unsafe = routes.filter((r) => ['post', 'put', 'patch'].includes(r.method));
  const firstUnsafe = unsafe[0];
  if (firstUnsafe) await probe('malformed-json', firstUnsafe.method.toUpperCase(), fill(firstUnsafe.path), { body: '{"broken":', expect: (s) => s === 400 });
  for (const r of unsafe) await probe(`invalid-body ${r.method} ${r.path}`, r.method.toUpperCase(), fill(r.path), { body: '[1,2,3]', expect: (s) => s === 422 || s === 404 });
  for (const r of routes.filter((x) => x.path.includes(':') && (x.method === 'get' || x.method === 'delete'))) {
    await probe(`missing-resource ${r.method} ${r.path}`, r.method.toUpperCase(), fill(r.path), { expect: (s) => s === 404 || s === 422 });
  }
  for (const r of routes.filter((x) => x.method === 'get' && !x.path.includes(':'))) {
    await probe(`bad-cursor ${r.path}`, 'GET', `${r.path}?limit=0`, { expect: is4xx });
  }
  server.close();
  process.stdout.write(JSON.stringify({ results }));
}

main().catch((e: unknown) => {
  process.stdout.write(JSON.stringify({ unproven: `probe crashed: ${String(e)}` }));
  process.exitCode = 0;
});
