import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// Solo se pasa el flag si esta versión de Node lo conoce (Node < 22 no arrancaría con él).
const webstorageOffArgs = process.allowedNodeEnvironmentFlags.has('--no-experimental-webstorage')
  ? ['--no-experimental-webstorage']
  : []

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.{js,jsx}'],
    // Varios tests importan páginas grandes (ContentLibraryPage, Dashboard.jsx) dentro del
    // propio test; en máquinas lentas eso solo ya supera los 5 s por defecto.
    testTimeout: 30000,
    poolOptions: {
      // Node 25+ trae un localStorage global que, sin --localstorage-file, vale undefined
      // y tapa el de jsdom ("Cannot read properties of undefined (reading 'getItem')").
      forks: { execArgv: webstorageOffArgs },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_API_URL || 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
    },
  },
})
