import { Router } from 'express';
import { createIdempotencyStore, IdempotencyHeadersSchema } from '../lib/idempotency';
import { paginate } from '../lib/pagination';
import {
  CreateUserBodySchema,
  ListUsersQuerySchema,
  UpdateUserBodySchema,
  UserPageSchema,
  UserParamsSchema,
  UserSchema,
  type User,
} from '../schemas/users';
import { createUserStore, type UserStore } from '../store/users';

export function usersRouter(store: UserStore = createUserStore()): Router {
  const router = Router();
  const idempotency = createIdempotencyStore<User>();

  router.get('/v1/users', (req, res) => {
    const query = ListUsersQuerySchema.parse(req.query);
    const users = store.list().filter((u) => query.role === undefined || u.role === query.role);
    res.status(200).json(UserPageSchema.parse(paginate(users, query)));
  });

  router.post('/v1/users', async (req, res) => {
    const headers = IdempotencyHeadersSchema.parse(req.headers);
    const body = CreateUserBodySchema.parse(req.body);
    const { value: user } = await idempotency.run(headers['idempotency-key'], body, () => store.create(body));
    res.status(201).location(`/v1/users/${user.id}`).json(UserSchema.parse(user));
  });

  router.get('/v1/users/:id', (req, res) => {
    const { id } = UserParamsSchema.parse(req.params);
    res.status(200).json(UserSchema.parse(store.get(id)));
  });

  router.patch('/v1/users/:id', (req, res) => {
    const { id } = UserParamsSchema.parse(req.params);
    const patch = UpdateUserBodySchema.parse(req.body);
    res.status(200).json(UserSchema.parse(store.update(id, patch)));
  });

  router.delete('/v1/users/:id', (req, res) => {
    const { id } = UserParamsSchema.parse(req.params);
    store.remove(id);
    res.status(204).end();
  });

  return router;
}
