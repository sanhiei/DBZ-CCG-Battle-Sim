import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** The game server (ws + /api) runs separately; proxy both in dev. */
const SERVER = process.env.DBZ_SERVER ?? 'http://localhost:8787';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: SERVER, changeOrigin: true },
      '/cards': { target: SERVER, changeOrigin: true },
      '/ws': { target: SERVER.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
