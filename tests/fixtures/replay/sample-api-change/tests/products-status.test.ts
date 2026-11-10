// @covers src/schemas/products.ts
// @covers src/store/products.ts
// @covers src/routes/products.ts
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createApp } from '../src/app';

const StatusView = z.object({ id: z.string(), status: z.enum(['active', 'archived']) });
const StatusPage = z.object({ data: z.array(StatusView), nextCursor: z.string().nullable() });

describe('product archive status', () => {
  it('defaults new products to active', async () => {
    const res = await request(createApp()).post('/v1/products').send({ sku: 'ARC-001', name: 'Lamp', priceCents: 500 });
    expect(res.status).toBe(201);
    expect(StatusView.parse(res.body).status).toBe('active');
  });

  it('archives a product with PATCH and filters the list by status', async () => {
    const app = createApp();
    const a = StatusView.parse((await request(app).post('/v1/products').send({ sku: 'ARC-002', name: 'Desk', priceCents: 9000 })).body);
    await request(app).post('/v1/products').send({ sku: 'ARC-003', name: 'Chair', priceCents: 4000 });
    const patched = await request(app).patch(`/v1/products/${a.id}`).send({ status: 'archived' });
    expect(patched.status).toBe(200);
    expect(StatusView.parse(patched.body).status).toBe('archived');
    const archived = StatusPage.parse((await request(app).get('/v1/products?status=archived')).body);
    expect(archived.data.map((p) => p.id)).toEqual([a.id]);
    const active = StatusPage.parse((await request(app).get('/v1/products?status=active')).body);
    expect(active.data).toHaveLength(1);
  });

  it('rejects an unknown status with a 422 problem', async () => {
    const res = await request(createApp()).get('/v1/products?status=deleted');
    expect(res.status).toBe(422);
    expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
  });
});
