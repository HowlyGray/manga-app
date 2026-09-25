import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // This machine only by default, like the API server: the proxy below would
    // otherwise hand the unauthenticated API to the whole network. `npm run
    // dev:lan` passes --host to open it to phones and tablets.
    port: 5173,
    proxy: {
      // 127.0.0.1 rather than localhost: the API binds IPv4 loopback, and
      // `localhost` can resolve to ::1 first.
      '/api': `http://127.0.0.1:${process.env.PORT ?? 5180}`,
    },
  },
  preview: {
    port: 4173,
  },
});
