import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    // Each test file runs in its own process with its own library and
    // database, which also keeps the native addons (better-sqlite3,
    // @napi-rs/canvas) out of shared worker threads.
    pool: 'forks',
    testTimeout: 30_000,
  },
});
