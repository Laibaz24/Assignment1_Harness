import { Router } from 'express';
import { createIdempotencyStore, IdempotencyHeadersSchema } from '../lib/idempotency';
import { paginate } from '../lib/pagination';
import {
  CreateProductBodySchema,
  ListProductsQuerySchema,
  ProductPageSchema,
  ProductParamsSchema,
  ProductSchema,
  UpdateProductBodySchema,
  type Product,
} from '../schemas/products';
import { createProductStore, type ProductStore } from '../store/products';

export function productsRouter(store: ProductStore = createProductStore()): Router {
  const router = Router();
  const idempotency = createIdempotencyStore<Product>();

  router.get('/v1/products', (req, res) => {
    const query = ListProductsQuerySchema.parse(req.query);
    const products = store
      .list()
      .filter(
        (p) =>
          (query.categoryId === undefined || p.categoryId === query.categoryId) &&
          (query.status === undefined || p.status === query.status),
      );
    res.status(200).json(ProductPageSchema.parse(paginate(products, query)));
  });

  router.post('/v1/products', async (req, res) => {
    const headers = IdempotencyHeadersSchema.parse(req.headers);
    const body = CreateProductBodySchema.parse(req.body);
    const { value: product } = await idempotency.run(headers['idempotency-key'], body, () => store.create(body));
    res.status(201).location(`/v1/products/${product.id}`).json(ProductSchema.parse(product));
  });

  router.get('/v1/products/:id', (req, res) => {
    const { id } = ProductParamsSchema.parse(req.params);
    res.status(200).json(ProductSchema.parse(store.get(id)));
  });

  router.patch('/v1/products/:id', (req, res) => {
    const { id } = ProductParamsSchema.parse(req.params);
    const patch = UpdateProductBodySchema.parse(req.body);
    res.status(200).json(ProductSchema.parse(store.update(id, patch)));
  });

  router.delete('/v1/products/:id', (req, res) => {
    const { id } = ProductParamsSchema.parse(req.params);
    store.remove(id);
    res.status(204).end();
  });

  return router;
}
