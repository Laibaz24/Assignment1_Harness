# API Standards

Every API the harness touches must satisfy these. Each section is enforced by a
check in `src/checks/rules/` (named in brackets) and fetched on demand by the
model with `read_standard(<id>)`. Nothing here is a style preference.

## zod-boundary

[check: `zod-boundary`, unit: handlers]

Every request input is parsed with a Zod schema before use, and every response
body is produced by a Zod schema.

- Read `req.params`, `req.query`, `req.body` and `req.headers` only as the direct
  argument of `Schema.parse(...)` (or `safeParse`, `parseAsync`).
  - `const { id } = UserParamsSchema.parse(req.params);`
  - `const query = ListUsersQuerySchema.parse(req.query);`
  - `const body = CreateUserBodySchema.parse(req.body);`
  - `const headers = IdempotencyHeadersSchema.parse(req.headers);`
- Routes with path parameters (`/:id`) must parse `req.params`.
- POST, PUT and PATCH handlers must parse `req.body`.
- Every `res.json(x)` / `res.send(x)` passes `Schema.parse(...)`:
  `res.status(200).json(UserSchema.parse(user));`
- `res.status(204).end()` is the only body-less response.
- A `ZodError` thrown by a parse becomes a 422 problem automatically (see problem-json).

Failing examples: `const id = req.params.id`, `res.json(user)`, `res.json({ ok: true })`.

## zod-infer

[check: `zod-infer`, unit: type declarations]

TypeScript types are inferred from schemas, never hand-written a second time.

- `export type User = z.infer<typeof UserSchema>;`
- No `interface` declarations under `src/`.
- A type alias must be derived (`z.infer`, `z.input`, `z.output`, `typeof`,
  `ReturnType<...>`). `type User = { id: string }` fails.

## problem-json

[checks: `problem-json` (static, unit: error paths) and `problem-json:runtime` (unit: probes)]

Every non-2xx response is `application/problem+json` (RFC 7807) with exactly
these members: `type`, `title`, `status`, `detail`, `instance`.

```
HTTP/1.1 422 Unprocessable Content
Content-Type: application/problem+json

{
  "type": "https://api.sf/problems/validation",
  "title": "Request failed validation",
  "status": 422,
  "detail": "email: Invalid email address",
  "instance": "/v1/users"
}
```

- Throw a problem from handlers and stores: `throw notFound(...)`,
  `throw conflict(...)`, `throw badRequest(...)`, `throw unprocessable(...)`
  from `src/lib/problem.ts`. Express 5 forwards async throws to `errorHandler`.
- Never call `res.status(4xx|5xx)` or `res.sendStatus(4xx)` outside the problem
  module. Never send `{ error: ... }`, `{ errors: ... }` or `{ message: ... }`.
- Throwing a plain `Error` fails the static check (it would surface as a generic 500).
- Status mapping: malformed JSON 400, unknown route / missing resource 404,
  duplicate or idempotency mismatch 409, validation 422, anything else 500.
- The runtime probe boots `createApp()` from `src/app.ts` and sends: an unknown
  route, malformed JSON, an invalid body to every unsafe route, a random id to
  every item route, and `limit=0` to every list route. Every response must be a
  well-formed problem whose `status` equals the HTTP status.

## strict-types

[checks: `tsc --strict` (unit: errors) and `strict-types` (unit: files)]

- `tsc --noEmit` passes with `strict` and `noUncheckedIndexedAccess` (forced on the
  command line, and required in `tsconfig.json`).
- No `any` (explicit or `as any`), no non-null assertions (`x!`), no
  `@ts-ignore`, `@ts-expect-error` or `@ts-nocheck` - in source and tests.
- With `noUncheckedIndexedAccess`, `arr[0]` is `T | undefined`: check it, or use
  `.find`, `.at` with a guard, or destructuring with a default.
- Parse unknown data (e.g. `res.body` in tests) with the schema instead of casting.

## rest-conventions

[check: `rest-conventions`, unit: routes]

- Versioned base path: every route starts with `/v1/` (or `/v2/`, ...).
- Plural nouns for every static segment: `/v1/users`, `/v1/users/:id/orders`.
  No verbs (`/v1/users/:id/activate` fails); model state changes as PATCH.
- Collection GET uses cursor pagination: query schema extends `CursorQuerySchema`
  (`cursor`, `limit` 1..100, default 20); response is
  `pageSchema(Item)` = `{ data: Item[], nextCursor: string | null }`.
- POST to a collection: responds `201` with a `Location` header, accepts an optional
  `Idempotency-Key` header (8..255 chars) through `createIdempotencyStore`; same
  key + same body replays the first result, same key + different body is `409`.
- DELETE responds `204` with no body.
- Item routes (`/:id`) have a 404 path (`throw notFound(...)`).
- Duplicates of unique fields are `409`; validation failures are `422`.
- Success statuses are limited to 200, 201, 202 and 204.

## contract-drift

[check: `contract-drift`, unit: pre-existing routes - brownfield only]

Before a brownfield run the harness snapshots the API contract: every route, its
success statuses, and the JSON Schema of the Zod schemas each handler parses
(params, query, body, headers, response). At finish it re-derives the contract
and diffs it. Breaking changes fail unless the task file lists the route under
`allowBreaking`:

- route removed, success status changed
- response: field removed, type changed, required field made optional, new enum value
- request: new required field, field removed, type changed, enum value removed,
  min/max/pattern/format tightened

Additive changes (new optional request fields, new response fields, new routes)
pass and are listed in the report.

## testing

- Tests live in `tests/*.test.ts` and use vitest + supertest against `createApp()`.
- Declare what a test covers at the top: `// @covers src/routes/users.ts`
  (one line per source file). Same-basename tests (`users.test.ts` ->
  `src/**/users.ts`) are mapped automatically.
- Observed red: a source file is refused until a covering test exists and the
  harness runner has seen it fail. Write the test, `run_tests`, see FAIL, then
  write the source.
- Assert problem responses by parsing with `ProblemSchema` and checking
  `content-type` starts with `application/problem+json`.
- Build a fresh app per test (`createApp()`); stores are in-memory.

## scaffold

Greenfield workspaces start from a harness-owned scaffold (read-only for the model):

- `src/lib/problem.ts`: `ProblemSchema`, `HttpProblem`, `badRequest`, `notFound`,
  `conflict`, `unprocessable`, `sendProblem`, `errorHandler`, `notFoundHandler`.
- `src/lib/pagination.ts`: `CursorQuerySchema`, `pageSchema(item)`, `paginate(items, query)`,
  `encodeCursor`, `decodeCursor`.
- `src/lib/idempotency.ts`: `IdempotencyHeadersSchema`, `createIdempotencyStore<T>()`
  with `run(key, payload, produce)`.
- `src/app.ts`: `createApp()`; mount routers before `notFoundHandler` / `errorHandler`.
- Suggested layout per resource: `src/schemas/<plural>.ts`, `src/store/<plural>.ts`,
  `src/routes/<plural>.ts` (export `<plural>Router()`), `tests/<plural>.test.ts`.
- Imports are extensionless (`'../lib/problem'`); module resolution is `Bundler`.
