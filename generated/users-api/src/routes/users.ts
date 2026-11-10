import { randomUUID } from 'node:crypto';
import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { createIdempotencyStore, IdempotencyHeadersSchema } from '../lib/idempotency';
import { CursorQuerySchema, pageSchema, paginate } from '../lib/pagination';
import { conflict, notFound, unprocessable } from '../lib/problem';

const UserRoleSchema = z.enum(['admin', 'member']);

const UserSchema = z.object({
  id: z.string().min(1),
  email: z.string().email(),
  name: z.string().min(1).max(100),
  role: UserRoleSchema,
});
type User = z.infer<typeof UserSchema>;

const UserParamsSchema = z.object({
  id: z.string().min(1),
});

const ListUsersQuerySchema = CursorQuerySchema.extend({
  role: UserRoleSchema.optional(),
});

const CreateUserBodySchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(100),
  role: UserRoleSchema.default('member'),
});
type CreateUserBody = z.infer<typeof CreateUserBodySchema>;

const PatchUserBodySchema = z
  .object({
    email: z.string().email().optional(),
    name: z.string().min(1).max(100).optional(),
    role: UserRoleSchema.optional(),
  })
  .strict()
  .refine((patch) => patch.email !== undefined || patch.name !== undefined || patch.role !== undefined, {
    message: 'PATCH body must include at least one user field',
  });
type PatchUserBody = z.infer<typeof PatchUserBodySchema>;

const UsersPageSchema = pageSchema(UserSchema);
const CreateUserResultSchema = z.object({
  user: UserSchema,
  location: z.string().startsWith('/v1/users/'),
});
type CreateUserResult = z.infer<typeof CreateUserResultSchema>;

function createUser(body: CreateUserBody, users: Map<string, User>): CreateUserResult {
  const existing = Array.from(users.values()).find((user) => user.email === body.email);
  if (existing !== undefined) throw conflict('email already exists');

  const user = UserSchema.parse({ id: randomUUID(), email: body.email, name: body.name, role: body.role });
  users.set(user.id, user);
  return { user, location: `/v1/users/${user.id}` };
}

function getUser(id: string, users: Map<string, User>): User {
  const user = users.get(id);
  if (user === undefined) throw notFound('user not found');
  return user;
}

function patchUser(id: string, patch: PatchUserBody, users: Map<string, User>): User {
  const current = getUser(id, users);
  if (patch.email !== undefined) {
    const duplicate = Array.from(users.values()).find((user) => user.email === patch.email && user.id !== id);
    if (duplicate !== undefined) throw conflict('email already exists');
  }

  const updated = UserSchema.parse({
    id: current.id,
    email: patch.email ?? current.email,
    name: patch.name ?? current.name,
    role: patch.role ?? current.role,
  });
  users.set(updated.id, updated);
  return updated;
}

export function usersRouter(): Router {
  const router = Router();
  const users = new Map<string, User>();
  const idempotency = createIdempotencyStore<CreateUserResult>();

  const listUsers: RequestHandler = (req, res) => {
    const query = ListUsersQuerySchema.parse(req.query);
    const filtered = Array.from(users.values()).filter((user) => query.role === undefined || user.role === query.role);
    const page = paginate(filtered, query);
    res.status(200).json(UsersPageSchema.parse(page));
  };

  const postUser: RequestHandler = async (req, res) => {
    const headers = IdempotencyHeadersSchema.parse(req.headers);
    const body = CreateUserBodySchema.parse(req.body);
    const result = await idempotency.run(headers['idempotency-key'], body, () => createUser(body, users));
    res.status(201).location(result.value.location).json(UserSchema.parse(result.value.user));
  };

  const getUserById: RequestHandler = (req, res) => {
    const params = UserParamsSchema.parse(req.params);
    const user = getUser(params.id, users);
    res.status(200).json(UserSchema.parse(user));
  };

  const patchUserById: RequestHandler = (req, res) => {
    const params = UserParamsSchema.parse(req.params);
    const parsedPatch = PatchUserBodySchema.safeParse(req.body);
    if (!parsedPatch.success) throw unprocessable('PATCH body must include at least one valid user field');
    const user = patchUser(params.id, parsedPatch.data, users);
    res.status(200).json(UserSchema.parse(user));
  };

  const deleteUserById: RequestHandler = (req, res) => {
    const params = UserParamsSchema.parse(req.params);
    getUser(params.id, users);
    users.delete(params.id);
    res.status(204).end();
  };

  router.get('/v1/users', listUsers);
  router.post('/v1/users', postUser);
  router.get('/v1/users/:id', getUserById);
  router.patch('/v1/users/:id', patchUserById);
  router.delete('/v1/users/:id', deleteUserById);

  return router;
}
