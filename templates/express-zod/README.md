# Generated API

Generated and governed by ts-api-harness. Scaffold library in `src/lib` is harness-owned.

- `npm test` runs vitest, `npm run typecheck` runs tsc (strict).
- Errors: RFC 7807 `application/problem+json` via `src/lib/problem.ts`.
- Pagination: cursor based via `src/lib/pagination.ts`.
- Idempotency: `Idempotency-Key` header on POST via `src/lib/idempotency.ts`.
