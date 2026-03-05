import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
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
      '/api/stops/minimap': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/api/stops/reload': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
})
