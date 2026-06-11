import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Local dev against the kind cluster: the BFF owns /auth behind Caddy.
      '/auth': {
        target: 'https://localhost:8443',
        changeOrigin: true,
        secure: false, // Caddy's local CA is self-signed
      },
    },
  },
  test: {
    environment: 'jsdom',
  },
});
