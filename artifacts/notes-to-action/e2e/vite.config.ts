import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// This config is used ONLY by Playwright's loopback server, never dev/build.
// Keep the real AuthProvider/AuthGate and QueryClient; substitute only the SDK.
export default defineConfig({
  root: path.resolve(import.meta.dirname, '..'),
  plugins: [react(), tailwindcss({ optimize: false })],
  resolve: {
    alias: [
      { find: /^@clerk\/react(?:\/internal)?$/, replacement: path.resolve(import.meta.dirname, 'clerk-fixture.tsx') },
      { find: '@', replacement: path.resolve(import.meta.dirname, '../src') },
    ],
    dedupe: ['react', 'react-dom'],
  },
  server: { host: '127.0.0.1', port: 4179, strictPort: true },
});
