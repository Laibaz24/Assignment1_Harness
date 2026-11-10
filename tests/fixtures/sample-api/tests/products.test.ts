// @covers src/app.ts
// @covers src/routes/products.ts
// @covers src/schemas/products.ts
// @covers src/store/products.ts
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { ProblemSchema } from '../src/lib/problem';
import { ProductPageSchema, ProductSchema } from '../src/schemas/products';

const widget = { sku: 'WID-001', name: 'Widget', priceCents: 1299 };

function expectProblem(res: request.Response, status: number): void {
  expect(res.status).toBe(status);
  expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
  expect(ProblemSchema.parse(JSON.parse(res.text)).status).toBe(status);
}

describe('products API /v1/products', () => {
  it('creates a product with 201', async () => {
    const res = await request(createApp()).post('/v1/products').send(widget);
    expect(res.status).toBe(201);
    const product = ProductSchema.parse(res.body);
    expect(product.categoryId).toBeNull();
    expect(res.headers['location']).toBe(`/v1/products/${product.id}`);
  });

  it('rejects duplicate sku with 409 and invalid body with 422', async () => {
    const app = createApp();
    await request(app).post('/v1/products').send(widget);
    expectProblem(await request(app).post('/v1/products').send(widget), 409);
    expectProblem(await request(app).post('/v1/products').send({ ...widget, sku: 'x', priceCents: -1 }), 422);
  });

  it('paginates with a cursor', async () => {
    const app = createApp();
    for (let i = 0; i < 3; i++) await request(app).post('/v1/products').send({ ...widget, sku: `WID-00${i}` });
    const page1 = ProductPageSchema.parse((await request(app).get('/v1/products?limit=2')).body);
    expect(page1.data).toHaveLength(2);
    const page2 = ProductPageSchema.parse((await request(app).get(`/v1/products?limit=2&cursor=${page1.nextCursor ?? ''}`)).body);
    expect(page2.data).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
  });

  it('gets, patches and deletes a product', async () => {
    const app = createApp();
    const created = ProductSchema.parse((await request(app).post('/v1/products').send(widget)).body);
    expect((await request(app).get(`/v1/products/${created.id}`)).status).toBe(200);
    const patched = await request(app).patch(`/v1/products/${created.id}`).send({ priceCents: 999 });
    expect(ProductSchema.parse(patched.body).priceCents).toBe(999);
    expect((await request(app).delete(`/v1/products/${created.id}`)).status).toBe(204);
    expectProblem(await request(app).get(`/v1/products/${created.id}`), 404);
  });
});
