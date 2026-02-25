import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api/bustime': {
        target: 'https://bustime.mta.info',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/bustime/, '/m/'),
      },
    },
  },
})
