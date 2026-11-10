import { z } from 'zod';
import { CursorQuerySchema, pageSchema } from '../lib/pagination';

export const UserRoleSchema = z.enum(['admin', 'member']);

export const UserSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  name: z.string().min(1).max(100),
  role: UserRoleSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type User = z.infer<typeof UserSchema>;

export const CreateUserBodySchema = z.strictObject({
  email: z.email(),
  name: z.string().trim().min(1).max(100),
  role: UserRoleSchema.default('member'),
});
export type CreateUserBody = z.infer<typeof CreateUserBodySchema>;

export const UpdateUserBodySchema = z
  .strictObject({
    email: z.email().optional(),
    name: z.string().trim().min(1).max(100).optional(),
    role: UserRoleSchema.optional(),
  })
  .refine((body) => Object.values(body).some((v) => v !== undefined), { message: 'at least one field is required' });
export type UpdateUserBody = z.infer<typeof UpdateUserBodySchema>;

export const UserParamsSchema = z.object({ id: z.uuid() });

export const ListUsersQuerySchema = CursorQuerySchema.extend({ role: UserRoleSchema.optional() });

export const UserPageSchema = pageSchema(UserSchema);
