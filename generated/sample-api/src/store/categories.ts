import { randomUUID } from 'node:crypto';
import { conflict, notFound } from '../lib/problem';
import type { Category, CreateCategoryBody } from '../schemas/categories';

export function createCategoryStore() {
  const categories = new Map<string, Category>();
  return {
    list: (): Category[] => [...categories.values()],
    get(id: string): Category {
      const category = categories.get(id);
      if (category === undefined) throw notFound(`Category ${id} does not exist`);
      return category;
    },
    create(input: CreateCategoryBody): Category {
      for (const c of categories.values()) if (c.slug === input.slug) throw conflict(`A category with slug ${input.slug} already exists`);
      const category: Category = { id: randomUUID(), slug: input.slug, title: input.title, createdAt: new Date().toISOString() };
      categories.set(category.id, category);
      return category;
    },
  };
}

export type CategoryStore = ReturnType<typeof createCategoryStore>;
