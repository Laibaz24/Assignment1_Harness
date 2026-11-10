import express, { type Express } from 'express';
import { errorHandler, notFoundHandler } from './lib/problem';
import { categoriesRouter } from './routes/categories';
import { productsRouter } from './routes/products';

export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ type: ['application/json', 'application/*+json'] }));

  app.use(categoriesRouter());
  app.use(productsRouter());

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
