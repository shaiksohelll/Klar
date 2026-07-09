import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Backend the dev server proxies to. The hosted API enforces a CORS allowlist
// that (in production mode) rejects arbitrary browser origins, so we proxy
// same-origin `/proxy/*` requests through the dev server instead of hitting the
// API cross-origin from the browser. Requests forwarded by the dev server carry
// no browser `Origin` header, so the API's "no origin = allow" branch passes.
// eslint-disable-next-line no-undef
const API_PROXY_TARGET =
  // eslint-disable-next-line no-undef
  process.env.API_PROXY_TARGET || 'https://klar-api-6rxn.onrender.com'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // eslint-disable-next-line no-undef
    alias: process.env.VITE_E2E_MOCK_AUTH === 'true' ? {
      '@clerk/clerk-react': path.resolve(__dirname, './src/lib/mockClerk.jsx'),
    } : {},
  },
  server: {
    proxy: {
      '/proxy': {
        target: API_PROXY_TARGET,
        changeOrigin: true,
        secure: true,
        rewrite: (p) => p.replace(/^\/proxy/, ''),
        configure: (proxy) => {
          // Strip the browser Origin so the API treats this as a
          // server-to-server call and skips its CORS allowlist check.
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.removeHeader('origin')
          })
        },
      },
    },
  },
})
