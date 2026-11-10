/**
 * Converts exported Zod schemas to JSON Schema. Run as a subprocess:
 *   node --import tsx src/checks/runtime/contract-dump.ts <refs.json>
 * refs.json: [{ id, file, name, io: "input" | "output" }]
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

const Refs = z.array(z.object({ id: z.string(), file: z.string(), name: z.string(), io: z.enum(['input', 'output']) }));

async function main(): Promise<void> {
  const refsFile = process.argv[2];
  if (!refsFile) throw new Error('usage: contract-dump.ts <refs.json>');
  const refs = Refs.parse(JSON.parse(readFileSync(refsFile, 'utf8')));
  const out: Record<string, unknown> = {};
  const cache = new Map<string, Record<string, unknown>>();
  for (const r of refs) {
    try {
      let mod = cache.get(r.file);
      if (!mod) {
        mod = (await import(pathToFileURL(r.file).href)) as Record<string, unknown>;
        cache.set(r.file, mod);
      }
      const schema = mod[r.name];
      if (!(schema instanceof z.ZodType)) {
        out[r.id] = { unresolved: `${r.name} is not an exported Zod schema` };
        continue;
      }
      out[r.id] = z.toJSONSchema(schema, { io: r.io, unrepresentable: 'any' });
    } catch (e) {
      out[r.id] = { unresolved: String(e).slice(0, 200) };
    }
  }
  process.stdout.write(JSON.stringify(out));
}

main().catch((e: unknown) => {
  process.stdout.write(JSON.stringify({ __error: String(e) }));
});
