// @covers src/routes/categories.ts
// @covers src/schemas/categories.ts
// @covers src/store/categories.ts
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { ProblemSchema } from '../src/lib/problem';
import { CategoryPageSchema, CategorySchema } from '../src/schemas/categories';

describe('categories API /v1/categories', () => {
  it('creates, gets and lists categories', async () => {
    const app = createApp();
    const res = await request(app).post('/v1/categories').send({ slug: 'tools', title: 'Tools' });
    expect(res.status).toBe(201);
    const created = CategorySchema.parse(res.body);
    expect(CategorySchema.parse((await request(app).get(`/v1/categories/${created.id}`)).body).slug).toBe('tools');
    expect(CategoryPageSchema.parse((await request(app).get('/v1/categories')).body).data).toHaveLength(1);
  });

  it('returns 409 for a duplicate slug and 404 for a missing category', async () => {
    const app = createApp();
    await request(app).post('/v1/categories').send({ slug: 'tools', title: 'Tools' });
    const dup = await request(app).post('/v1/categories').send({ slug: 'tools', title: 'Again' });
    expect(dup.status).toBe(409);
    expect(ProblemSchema.parse(JSON.parse(dup.text)).status).toBe(409);
    const missing = await request(app).get('/v1/categories/7d0f3a8e-5b1c-4f7a-9a51-2c3d4e5f6a7b');
    expect(missing.status).toBe(404);
    expect(missing.headers['content-type']).toMatch(/^application\/problem\+json/);
  });
});
