import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config';
import { getDb } from './db';
import { apiRouter } from './routes/api';

const app = express();

app.use(cors());
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

app.listen(config.port, () => {
  getDb();
  console.log(`Manga app server listening on http://localhost:${config.port}`);
  console.log(`  library: ${config.libraryDir}`);
  console.log(`  db:      ${config.dataDir}`);
});