import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:3000',
      '/socket': { target: 'ws://127.0.0.1:3000', ws: true },
    },
  },
});
