/**
 * RFC 7807 problem details. Harness-owned scaffold: every non-2xx response in the
 * API goes through sendProblem(). Throw one of the factories from a handler;
 * errorHandler turns it into application/problem+json.
 */
import type { ErrorRequestHandler, RequestHandler, Response } from 'express';
import { z, ZodError } from 'zod';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';
const PROBLEM_BASE = 'https://api.sf/problems/';

export const ProblemSchema = z.object({
  type: z.url(),
  title: z.string().min(1),
  status: z.number().int().min(400).max(599),
  detail: z.string(),
  instance: z.string().startsWith('/'),
});
export type Problem = z.infer<typeof ProblemSchema>;

export class HttpProblem extends Error {
  readonly status: number;
  readonly slug: string;
  readonly title: string;
  readonly detail: string;

  constructor(status: number, slug: string, title: string, detail: string) {
    super(detail);
    this.name = 'HttpProblem';
    this.status = status;
    this.slug = slug;
    this.title = title;
    this.detail = detail;
  }
}

export const badRequest = (detail: string): HttpProblem => new HttpProblem(400, 'bad-request', 'Malformed request', detail);
export const notFound = (detail: string): HttpProblem => new HttpProblem(404, 'not-found', 'Resource not found', detail);
export const conflict = (detail: string): HttpProblem => new HttpProblem(409, 'conflict', 'Resource conflict', detail);
export const unprocessable = (detail: string): HttpProblem => new HttpProblem(422, 'validation', 'Request failed validation', detail);
const internal = (): HttpProblem => new HttpProblem(500, 'internal', 'Internal server error', 'An unexpected error occurred');

export function zodDetail(err: ZodError): string {
  return err.issues.map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`).join('; ');
}

export function sendProblem(res: Response, instance: string, p: HttpProblem): void {
  const body = ProblemSchema.parse({
    type: PROBLEM_BASE + p.slug,
    title: p.title,
    status: p.status,
    detail: p.detail,
    instance,
  });
  res.status(body.status).set('Content-Type', PROBLEM_CONTENT_TYPE).send(JSON.stringify(body));
}

const BodyParserError = z.object({ type: z.string().startsWith('entity.'), status: z.number().int().min(400).max(499) });

/** Last middleware: every error becomes a problem+json response. */
export const errorHandler: ErrorRequestHandler = (err: unknown, req, res, _next) => {
  const instance = req.originalUrl.split('?')[0] ?? '/';
  if (err instanceof HttpProblem) return sendProblem(res, instance, err);
  if (err instanceof ZodError) return sendProblem(res, instance, unprocessable(zodDetail(err)));
  const parseError = BodyParserError.safeParse(err);
  if (parseError.success) {
    const detail = parseError.data.type === 'entity.parse.failed' ? 'Request body is not valid JSON' : `Request body rejected (${parseError.data.type})`;
    return sendProblem(res, instance, new HttpProblem(parseError.data.status, 'bad-request', 'Malformed request', detail));
  }
  return sendProblem(res, instance, internal());
};

/** Mounted after all routers: unknown routes are 404 problems, not HTML. */
export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(notFound(`No route for ${req.method} ${req.path}`));
};
