import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  publicDir: fileURLToPath(new URL('../../frontend/public', import.meta.url)),
  server: { host: '127.0.0.1', port: 5194, strictPort: true },
})
