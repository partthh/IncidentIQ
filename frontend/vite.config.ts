import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The dev server proxies to the Spring Boot backend so the browser sees a single
// origin. That matters for more than tidiness: the STOMP connection is opened over
// WebSocket to the same host, and a cross-origin socket upgrade needs the backend's
// CORS and proxy configuration to agree. Same-origin in dev, same-origin in Docker,
// one set of rules.
const backend = process.env.SENTINEL_API_URL ?? 'http://localhost:8080'

const wsTarget = backend.replace(/^http/, 'ws')

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: backend, changeOrigin: true },
      '/actuator': { target: backend, changeOrigin: true },
      // The browser cannot send headers on a WebSocket upgrade, so the token travels
      // in the first STOMP CONNECT frame instead. The proxy therefore only needs to
      // carry the handshake.
      '/ws': { target: wsTarget, ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
})