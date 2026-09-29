import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const backend = process.env.DEV_BACKEND_URL ?? 'http://localhost:8080';

export default defineConfig({
  root: 'src/web',
  publicDir: 'public',
  plugins: [react()],
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': backend,
      '/ws': { target: backend.replace(/^http/, 'ws'), ws: true },
    },
  },
});
