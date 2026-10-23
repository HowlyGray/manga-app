import os from 'node:os';
import { createApp } from './app';
import { config } from './config';
import { getDb } from './db';
import { sweepStaleTranslations } from './services/imgtranslate';
import { scheduleUpdateChecks } from './services/updates';

const app = createApp();

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
  } else {
    console.log('  this machine only; the :lan scripts open it to other devices');
  }
  console.log(`  library: ${config.libraryDir}`);
  console.log(`  db:      ${config.dataDir}`);

  // New chapters are looked for without anyone asking, so they are there when
  // the app is opened.
  scheduleUpdateChecks();
  if (config.updates.enabled) {
    const minutes = (ms: number) => Math.round(ms / 60_000);
    console.log(
      `  updates: new chapters checked at start and every ${minutes(config.updates.intervalMs)} min ` +
        `(a title is re-read after ${minutes(config.updates.staleMs)} min)`,
    );
  } else {
    console.log('  updates: automatic checks are off (AUTO_UPDATE=0)');
  }

  // Superseded translation renders are never read again. Reclaim the space in
  // the background so a large library does not hold up startup.
  sweepStaleTranslations().then(
    ({ files, bytes }) => {
      if (files > 0) {
        console.log(`[cache] removed ${files} stale translation files (${Math.round(bytes / 1048576)} MB)`);
      }
    },
    (err: unknown) => console.warn(`[cache] sweep failed: ${err instanceof Error ? err.message : err}`),
  );
});