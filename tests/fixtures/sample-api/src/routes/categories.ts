import { Router } from 'express';
import { createIdempotencyStore, IdempotencyHeadersSchema } from '../lib/idempotency';
import { paginate } from '../lib/pagination';
import {
  CategoryPageSchema,
  CategoryParamsSchema,
  CategorySchema,
  CreateCategoryBodySchema,
  ListCategoriesQuerySchema,
  type Category,
} from '../schemas/categories';
import { createCategoryStore, type CategoryStore } from '../store/categories';

export function categoriesRouter(store: CategoryStore = createCategoryStore()): Router {
  const router = Router();
  const idempotency = createIdempotencyStore<Category>();

  router.get('/v1/categories', (req, res) => {
    const query = ListCategoriesQuerySchema.parse(req.query);
    res.status(200).json(CategoryPageSchema.parse(paginate(store.list(), query)));
  });

  router.post('/v1/categories', async (req, res) => {
    const headers = IdempotencyHeadersSchema.parse(req.headers);
    const body = CreateCategoryBodySchema.parse(req.body);
    const { value: category } = await idempotency.run(headers['idempotency-key'], body, () => store.create(body));
    res.status(201).location(`/v1/categories/${category.id}`).json(CategorySchema.parse(category));
  });

  router.get('/v1/categories/:id', (req, res) => {
    const { id } = CategoryParamsSchema.parse(req.params);
    res.status(200).json(CategorySchema.parse(store.get(id)));
  });

  return router;
}
