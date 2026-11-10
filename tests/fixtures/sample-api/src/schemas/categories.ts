import { z } from 'zod';
import { CursorQuerySchema, pageSchema } from '../lib/pagination';

export const CategorySchema = z.object({
  id: z.uuid(),
  slug: z.string().regex(/^[a-z0-9-]{2,64}$/),
  title: z.string().min(1).max(120),
  createdAt: z.iso.datetime(),
});
export type Category = z.infer<typeof CategorySchema>;

export const CreateCategoryBodySchema = z.strictObject({
  slug: z.string().regex(/^[a-z0-9-]{2,64}$/),
  title: z.string().trim().min(1).max(120),
});
export type CreateCategoryBody = z.infer<typeof CreateCategoryBodySchema>;

export const CategoryParamsSchema = z.object({ id: z.uuid() });

export const ListCategoriesQuerySchema = CursorQuerySchema;

export const CategoryPageSchema = pageSchema(CategorySchema);
