// @covers src/app.ts
// @covers src/routes/users.ts
// @covers src/schemas/users.ts
// @covers src/store/users.ts
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createApp } from '../src/app';
import { ProblemSchema } from '../src/lib/problem';
import { UserPageSchema, UserSchema } from '../src/schemas/users';

const ada = { email: 'ada@example.com', name: 'Ada Lovelace' };

function expectProblem(res: request.Response, status: number): z.infer<typeof ProblemSchema> {
  expect(res.status).toBe(status);
  expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
  const problem = ProblemSchema.parse(JSON.parse(res.text));
  expect(problem.status).toBe(status);
  return problem;
}

describe('users API /v1/users', () => {
  it('creates a user with 201, Location and default role', async () => {
    const res = await request(createApp()).post('/v1/users').send(ada);
    expect(res.status).toBe(201);
    const user = UserSchema.parse(res.body);
    expect(user.role).toBe('member');
    expect(res.headers['location']).toBe(`/v1/users/${user.id}`);
  });

  it('rejects an invalid body with a 422 problem naming the field', async () => {
    const res = await request(createApp()).post('/v1/users').send({ email: 'not-an-email', name: '' });
    const problem = expectProblem(res, 422);
    expect(problem.detail).toContain('email');
    expect(problem.instance).toBe('/v1/users');
  });

  it('rejects malformed JSON with a 400 problem', async () => {
    const res = await request(createApp()).post('/v1/users').set('Content-Type', 'application/json').send('{"email":');
    expectProblem(res, 400);
  });

  it('returns 409 for a duplicate email', async () => {
    const app = createApp();
    await request(app).post('/v1/users').send(ada);
    const res = await request(app).post('/v1/users').send({ ...ada, name: 'Other' });
    expectProblem(res, 409);
  });

  it('replays a retried POST with the same Idempotency-Key', async () => {
    const app = createApp();
    const first = await request(app).post('/v1/users').set('Idempotency-Key', 'retry-key-0001').send(ada);
    const second = await request(app).post('/v1/users').set('Idempotency-Key', 'retry-key-0001').send(ada);
    expect(second.status).toBe(201);
    expect(UserSchema.parse(second.body).id).toBe(UserSchema.parse(first.body).id);
  });

  it('returns 409 when an Idempotency-Key is reused with a different body', async () => {
    const app = createApp();
    await request(app).post('/v1/users').set('Idempotency-Key', 'retry-key-0002').send(ada);
    const res = await request(app).post('/v1/users').set('Idempotency-Key', 'retry-key-0002').send({ email: 'grace@example.com', name: 'Grace' });
    expectProblem(res, 409);
  });

  it('lists users with cursor pagination', async () => {
    const app = createApp();
    for (let i = 0; i < 3; i++) await request(app).post('/v1/users').send({ email: `u${i}@example.com`, name: `User ${i}` });
    const page1 = UserPageSchema.parse((await request(app).get('/v1/users?limit=2')).body);
    expect(page1.data).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = UserPageSchema.parse((await request(app).get(`/v1/users?limit=2&cursor=${page1.nextCursor ?? ''}`)).body);
    expect(page2.data).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
  });

  it('filters the list by role', async () => {
    const app = createApp();
    await request(app).post('/v1/users').send({ ...ada, role: 'admin' });
    await request(app).post('/v1/users').send({ email: 'm@example.com', name: 'Member' });
    const page = UserPageSchema.parse((await request(app).get('/v1/users?role=admin')).body);
    expect(page.data.map((u) => u.role)).toEqual(['admin']);
  });

  it('rejects an invalid limit with a 422 problem', async () => {
    expectProblem(await request(createApp()).get('/v1/users?limit=0'), 422);
  });

  it('gets a user by id and 404s for an unknown id', async () => {
    const app = createApp();
    const created = UserSchema.parse((await request(app).post('/v1/users').send(ada)).body);
    const res = await request(app).get(`/v1/users/${created.id}`);
    expect(res.status).toBe(200);
    expect(UserSchema.parse(res.body).email).toBe(ada.email);
    expectProblem(await request(app).get('/v1/users/7d0f3a8e-5b1c-4f7a-9a51-2c3d4e5f6a7b'), 404);
  });

  it('rejects a malformed id with a 422 problem', async () => {
    expectProblem(await request(createApp()).get('/v1/users/not-a-uuid'), 422);
  });

  it('patches a user and validates the patch', async () => {
    const app = createApp();
    const created = UserSchema.parse((await request(app).post('/v1/users').send(ada)).body);
    const res = await request(app).patch(`/v1/users/${created.id}`).send({ name: 'Ada King' });
    expect(res.status).toBe(200);
    expect(UserSchema.parse(res.body).name).toBe('Ada King');
    expectProblem(await request(app).patch(`/v1/users/${created.id}`).send({}), 422);
  });

  it('deletes a user with 204 and then 404s', async () => {
    const app = createApp();
    const created = UserSchema.parse((await request(app).post('/v1/users').send(ada)).body);
    const del = await request(app).delete(`/v1/users/${created.id}`);
    expect(del.status).toBe(204);
    expect(del.text).toBe('');
    expectProblem(await request(app).delete(`/v1/users/${created.id}`), 404);
  });

  it('answers unknown routes with a 404 problem', async () => {
    expectProblem(await request(createApp()).get('/v1/nope'), 404);
  });
});
