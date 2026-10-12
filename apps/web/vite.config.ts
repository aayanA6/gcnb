import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const server = `127.0.0.1:${process.env.GCNB_PORT ?? 8787}`

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    fs: { allow: ['../..'] }, // themes/*.json live at the repo root
    proxy: {
      '/ws': { target: `ws://${server}`, ws: true },
      '/api': `http://${server}`,
    },
  },
})
