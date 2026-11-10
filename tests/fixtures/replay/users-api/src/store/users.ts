import { randomUUID } from 'node:crypto';
import { conflict, notFound } from '../lib/problem';
import type { CreateUserBody, UpdateUserBody, User } from '../schemas/users';

export function createUserStore() {
  const users = new Map<string, User>();

  const assertEmailFree = (email: string, exceptId?: string): void => {
    for (const u of users.values()) {
      if (u.email.toLowerCase() === email.toLowerCase() && u.id !== exceptId) throw conflict(`A user with email ${email} already exists`);
    }
  };

  const get = (id: string): User => {
    const user = users.get(id);
    if (user === undefined) throw notFound(`User ${id} does not exist`);
    return user;
  };

  return {
    list: (): User[] => [...users.values()],
    get,
    create(input: CreateUserBody): User {
      assertEmailFree(input.email);
      const now = new Date().toISOString();
      const user: User = { id: randomUUID(), email: input.email, name: input.name, role: input.role, createdAt: now, updatedAt: now };
      users.set(user.id, user);
      return user;
    },
    update(id: string, patch: UpdateUserBody): User {
      const current = get(id);
      if (patch.email !== undefined) assertEmailFree(patch.email, id);
      const next: User = {
        ...current,
        email: patch.email ?? current.email,
        name: patch.name ?? current.name,
        role: patch.role ?? current.role,
        updatedAt: new Date().toISOString(),
      };
      users.set(id, next);
      return next;
    },
    remove(id: string): void {
      get(id);
      users.delete(id);
    },
  };
}

export type UserStore = ReturnType<typeof createUserStore>;
