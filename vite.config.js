import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  base: './', // relative assets — works at / (dev) and /veloh/ (GitHub Pages)
  plugins: [vue()],
  server: {
    port: Number(process.env.PORT) || 5173,
    // File-change events don't propagate across the 9P mount when the repo is
    // run from WSL on a Windows path — fall back to polling there.
    watch: { usePolling: process.cwd().startsWith('/mnt/') },
  },
})
