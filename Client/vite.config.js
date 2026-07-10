import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Backend the dev server proxies to.
//
// SAFE DEFAULT = a LOCAL backend. We deliberately do NOT default to the hosted
// API: the proxy strips the browser `Origin` (see `configure` below) to slip
// past the API's CORS allowlist, so a forgotten env var would silently send
// *mutating* requests (POST/DELETE /api/watchlist, ...) straight to real data.
//
// To point dev at a remote backend, set API_PROXY_TARGET explicitly — e.g. in
// Client/.env (gitignored):
//   API_PROXY_TARGET=https://klar-api-6rxn.onrender.com
// eslint-disable-next-line no-undef
const API_PROXY_TARGET = process.env.API_PROXY_TARGET || 'http://localhost:5000'

// A remote proxy target must never be silent — a hosted API means real data.
const IS_LOCAL_TARGET = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(API_PROXY_TARGET)
if (!IS_LOCAL_TARGET) {
  // eslint-disable-next-line no-undef
  console.warn(
    `\n\x1b[33m⚠  [vite] Dev proxy → REMOTE target: ${API_PROXY_TARGET}` +
    `\n   Mutating requests (POST/DELETE) will hit this backend's real data.` +
    `\n   Unset API_PROXY_TARGET to use the safe local default (http://localhost:5000).\x1b[0m\n`
  )
}

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