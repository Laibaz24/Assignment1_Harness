import { randomUUID } from 'node:crypto';
import { conflict, notFound } from '../lib/problem';
import type { CreateProductBody, Product, UpdateProductBody } from '../schemas/products';

export function createProductStore() {
  const products = new Map<string, Product>();

  const get = (id: string): Product => {
    const product = products.get(id);
    if (product === undefined) throw notFound(`Product ${id} does not exist`);
    return product;
  };

  return {
    list: (): Product[] => [...products.values()],
    get,
    create(input: CreateProductBody): Product {
      for (const p of products.values()) if (p.sku === input.sku) throw conflict(`A product with sku ${input.sku} already exists`);
      const now = new Date().toISOString();
      const product: Product = {
        id: randomUUID(),
        sku: input.sku,
        name: input.name,
        priceCents: input.priceCents,
        categoryId: input.categoryId,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      };
      products.set(product.id, product);
      return product;
    },
    update(id: string, patch: UpdateProductBody): Product {
      const current = get(id);
      const next: Product = {
        ...current,
        name: patch.name ?? current.name,
        priceCents: patch.priceCents ?? current.priceCents,
        categoryId: patch.categoryId === undefined ? current.categoryId : patch.categoryId,
        status: patch.status ?? current.status,
        updatedAt: new Date().toISOString(),
      };
      products.set(id, next);
      return next;
    },
    remove(id: string): void {
      get(id);
      products.delete(id);
    },
  };
}

export type ProductStore = ReturnType<typeof createProductStore>;
