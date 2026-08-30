import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // Expose the dev server on the LAN too, so the same URL works from a phone.
    // The /api proxy runs server-side, so it still targets localhost.
    host: true,
    port: 5173,
    proxy: {
      '/api': `http://localhost:${process.env.PORT ?? 5180}`,
    },
  },
  preview: {
    host: true,
    port: 4173,
  },
});