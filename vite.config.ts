import { defineConfig } from 'vite';
import path from 'node:path';

export default defineConfig({
  root: path.resolve(__dirname, 'src/renderer'),
  publicDir: path.resolve(__dirname, 'src/renderer/public'),
  server: {
    port: 5173,
    strictPort: true,
    open: false,
    cors: true,
    host: '127.0.0.1',
    fs: {
      strict: false,
      allow: [
        path.resolve(__dirname),
        path.resolve(__dirname, 'src'),
        path.resolve(__dirname, 'node_modules'),
      ],
    },
  },
  // Keep Electron packages external in dev to avoid bundling
  optimizeDeps: {
    exclude: ['electron'],
  },
});
