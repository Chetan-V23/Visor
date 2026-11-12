import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    server: { host: '127.0.0.1' },
    build: { rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') } }
  }
})