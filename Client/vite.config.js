import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // eslint-disable-next-line no-undef
    alias: process.env.VITE_E2E_MOCK_AUTH === 'true' ? {
      '@clerk/clerk-react': path.resolve(__dirname, './src/lib/mockClerk.jsx'),
    } : {},
  },
})