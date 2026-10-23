import express, { type Express } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { guardApi } from './access';
import { apiRouter } from './routes/api';

/**
 * Builds the HTTP app without starting it, so tests can serve it on a spare
 * port. `index.ts` is what listens, prints addresses and sweeps caches.
 */
export function createApp(): Express {
  const app = express();

  // No CORS: the UI is same-origin, so cross-origin access only ever served other
  // sites. The guard also refuses requests that other sites trigger.
  app.use('/api', guardApi);
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', apiRouter);

  const webDist = path.resolve(import.meta.dirname, '..', '..', 'web', 'dist');
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist));
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
      res.sendFile(path.join(webDist, 'index.html'));
    });
  }

  app.use((req, res) => {
    res.status(404).json({ error: `not found: ${req.method} ${req.path}` });
  });
  return app;
}
