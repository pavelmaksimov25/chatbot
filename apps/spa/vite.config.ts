import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Local dev against the kind cluster: the BFF owns /auth and /me behind Caddy.
      '/auth': {
        target: 'https://localhost:8443',
        changeOrigin: true,
        secure: false, // Caddy's local CA is self-signed
      },
      '/me': {
        target: 'https://localhost:8443',
        changeOrigin: true,
        secure: false,
      },
      '/conversations': {
        target: 'https://localhost:8443',
        changeOrigin: true,
        secure: false,
      },
      '/files': {
        target: 'https://localhost:8443',
        changeOrigin: true,
        secure: false,
      },
    },
  },
  test: {
    environment: 'jsdom',
  },
});
