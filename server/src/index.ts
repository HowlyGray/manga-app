import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import os from 'node:os';
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

/** Non-loopback IPv4 addresses, so the console can print reachable URLs. */
function lanAddresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address);
}

app.listen(config.port, config.host, () => {
  getDb();
  console.log(`Manga app server listening on http://localhost:${config.port}`);
  if (config.host === '0.0.0.0') {
    // Printing the address is the whole point: on another device you need the
    // machine's IP, and there is no way to guess which interface is the right
    // one from the phone.
    for (const address of lanAddresses()) {
      console.log(`  on this network:  http://${address}:${config.port}`);
    }
  }
  console.log(`  library: ${config.libraryDir}`);
  console.log(`  db:      ${config.dataDir}`);
});