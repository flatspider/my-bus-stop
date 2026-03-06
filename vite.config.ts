import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ isSsrBuild }) => ({
  plugins: [react()],
  build: isSsrBuild
    ? undefined
    : {
        manifest: true,
      },
  server: {
    proxy: {
      '/api/bustime': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/api/stops/search': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/api/stops/nearby': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/api/stops/exists': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/api/stops/reload': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
}))
