// @covers src/app.ts
// @covers src/routes/users.ts
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { ProblemSchema } from '../src/lib/problem';

function expectProblem(response: request.Response, status: number): void {
  expect(response.status).toBe(status);
  expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
  const problem = ProblemSchema.parse(response.body);
  expect(problem.status).toBe(status);
}

describe('users API', () => {
  it('creates, replays idempotent create, gets, lists, patches, and deletes a user', async () => {
    const app = createApp();

    const created = await request(app)
      .post('/v1/users')
      .set('Idempotency-Key', 'create-alice-1')
      .send({ email: 'alice@example.com', name: 'Alice' });

    expect(created.status).toBe(201);
    expect(created.headers.location).toMatch(/^\/v1\/users\//);
    expect(created.body).toMatchObject({ email: 'alice@example.com', name: 'Alice', role: 'member' });
    expect(typeof created.body.id).toBe('string');

    const replayed = await request(app)
      .post('/v1/users')
      .set('Idempotency-Key', 'create-alice-1')
      .send({ email: 'alice@example.com', name: 'Alice' });

    expect(replayed.status).toBe(201);
    expect(replayed.headers.location).toBe(created.headers.location);
    expect(replayed.body).toEqual(created.body);

    const fetched = await request(app).get(`/v1/users/${created.body.id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body).toEqual(created.body);

    await request(app)
      .post('/v1/users')
      .set('Idempotency-Key', 'create-bob-01')
      .send({ email: 'bob@example.com', name: 'Bob', role: 'admin' })
      .expect(201);

    const memberPage = await request(app).get('/v1/users').query({ role: 'member', limit: 1 });
    expect(memberPage.status).toBe(200);
    expect(memberPage.body.data).toHaveLength(1);
    expect(memberPage.body.data[0]).toMatchObject({ email: 'alice@example.com', role: 'member' });
    expect(memberPage.body.nextCursor).toBeNull();

    const firstPage = await request(app).get('/v1/users').query({ limit: 1 });
    expect(firstPage.status).toBe(200);
    expect(firstPage.body.data).toHaveLength(1);
    expect(typeof firstPage.body.nextCursor).toBe('string');

    const secondPage = await request(app).get('/v1/users').query({ limit: 1, cursor: firstPage.body.nextCursor });
    expect(secondPage.status).toBe(200);
    expect(secondPage.body.data).toHaveLength(1);
    expect(secondPage.body.nextCursor).toBeNull();

    const patched = await request(app).patch(`/v1/users/${created.body.id}`).send({ name: 'Alice Updated', role: 'admin' });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ id: created.body.id, email: 'alice@example.com', name: 'Alice Updated', role: 'admin' });

    await request(app).delete(`/v1/users/${created.body.id}`).expect(204);

    const missing = await request(app).get(`/v1/users/${created.body.id}`);
    expectProblem(missing, 404);
  });

  it('returns conflicts for duplicate email and idempotency body mismatch', async () => {
    const app = createApp();

    await request(app)
      .post('/v1/users')
      .set('Idempotency-Key', 'create-carol-1')
      .send({ email: 'carol@example.com', name: 'Carol' })
      .expect(201);

    const duplicate = await request(app)
      .post('/v1/users')
      .set('Idempotency-Key', 'create-carol-2')
      .send({ email: 'carol@example.com', name: 'Carol Again' });
    expectProblem(duplicate, 409);

    const mismatch = await request(app)
      .post('/v1/users')
      .set('Idempotency-Key', 'create-carol-1')
      .send({ email: 'other@example.com', name: 'Other' });
    expectProblem(mismatch, 409);
  });

  it('validates list, create, and empty patch requests as problem details', async () => {
    const app = createApp();

    const invalidList = await request(app).get('/v1/users').query({ limit: 0 });
    expectProblem(invalidList, 422);

    const invalidCreate = await request(app)
      .post('/v1/users')
      .set('Idempotency-Key', 'bad-create-1')
      .send({ email: 'not-an-email', name: '' });
    expectProblem(invalidCreate, 422);

    const created = await request(app)
      .post('/v1/users')
      .set('Idempotency-Key', 'create-dana-1')
      .send({ email: 'dana@example.com', name: 'Dana' });
    expect(created.status).toBe(201);

    const emptyPatch = await request(app).patch(`/v1/users/${created.body.id}`).send({});
    expectProblem(emptyPatch, 422);
  });

  it('returns 409 when patch changes email to an existing user email', async () => {
    const app = createApp();

    const first = await request(app)
      .post('/v1/users')
      .set('Idempotency-Key', 'create-eve-001')
      .send({ email: 'eve@example.com', name: 'Eve' });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post('/v1/users')
      .set('Idempotency-Key', 'create-frank-1')
      .send({ email: 'frank@example.com', name: 'Frank' });
    expect(second.status).toBe(201);

    const duplicatePatch = await request(app).patch(`/v1/users/${second.body.id}`).send({ email: 'eve@example.com' });
    expectProblem(duplicatePatch, 409);
  });
});
