import { defineConfig } from 'vite';

export default defineConfig({
  // No SPA fallback: missing assets must 404 instead of returning index.html.
  appType: 'mpa',
  server: { port: 5173, strictPort: true, host: '127.0.0.1' },
  build: { target: 'es2023', sourcemap: true },
});
