import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), { name: 'dev-policy', transformIndexHtml(html, context) { return context.server ? html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*\/>/, '') : html } }],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: { host: '127.0.0.1', port: 5183, strictPort: true, hmr: { host: '127.0.0.1', port: 5183, protocol: 'ws' } },
})
