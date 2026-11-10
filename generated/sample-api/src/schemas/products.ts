import { z } from 'zod';
import { CursorQuerySchema, pageSchema } from '../lib/pagination';

export const ProductStatusSchema = z.enum(['active', 'archived']);
export type ProductStatus = z.infer<typeof ProductStatusSchema>;

export const ProductSchema = z.object({
  id: z.uuid(),
  sku: z.string().regex(/^[A-Z0-9-]{3,32}$/),
  name: z.string().min(1).max(200),
  priceCents: z.number().int().min(0),
  categoryId: z.uuid().nullable(),
  status: ProductStatusSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Product = z.infer<typeof ProductSchema>;

export const CreateProductBodySchema = z.strictObject({
  sku: z.string().regex(/^[A-Z0-9-]{3,32}$/),
  name: z.string().trim().min(1).max(200),
  priceCents: z.number().int().min(0),
  categoryId: z.uuid().nullable().default(null),
});
export type CreateProductBody = z.infer<typeof CreateProductBodySchema>;

export const UpdateProductBodySchema = z
  .strictObject({
    name: z.string().trim().min(1).max(200).optional(),
    priceCents: z.number().int().min(0).optional(),
    categoryId: z.uuid().nullable().optional(),
    status: ProductStatusSchema.optional(),
  })
  .refine((body) => Object.values(body).some((v) => v !== undefined), { message: 'at least one field is required' });
export type UpdateProductBody = z.infer<typeof UpdateProductBodySchema>;

export const ProductParamsSchema = z.object({ id: z.uuid() });

export const ListProductsQuerySchema = CursorQuerySchema.extend({ categoryId: z.uuid().optional(), status: ProductStatusSchema.optional() });

export const ProductPageSchema = pageSchema(ProductSchema);
