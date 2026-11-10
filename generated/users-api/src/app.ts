import express, { type Express } from 'express';
import { errorHandler, notFoundHandler } from './lib/problem';
import { usersRouter } from './routes/users';

export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ type: ['application/json', 'application/*+json'] }));

  app.use(usersRouter());

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
