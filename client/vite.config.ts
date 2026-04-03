import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3457,
    proxy: {
      '/api': {
        target: 'http://localhost:3456',
        changeOrigin: true,
      },
      '/ws': {
        target: 'http://localhost:3456',
        ws: true,
        changeOrigin: true,
        secure: false,
        // Forward cookies and auth headers
        configure: (proxy, _options) => {
          proxy.on('proxyReqWs', (proxyReq, req, _socket, _options, _head) => {
            // Forward the cookie header if present
            if (req.headers.cookie) {
              proxyReq.setHeader('Cookie', req.headers.cookie);
            }
          });
        },
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
