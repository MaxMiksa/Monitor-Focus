import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import { existsSync, rmSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { join } from 'node:path'

// https://vite.dev/config/
function excludeDevelopmentAssets(): Plugin {
  const developmentOnly = [
    'aligned-dusk-machine-clean-v1.png', 'aligned-midday-machine-clean-v1.png',
    'aligned-night-machine-clean-v1.png', 'scene-morning-machine-clean-v1.png',
    'scene-morph-mask-v7.png', 'scene-motion-prototype.html',
  ]
  return {
    name: 'exclude-development-assets',
    apply: 'build',
    closeBundle() {
      const output = fileURLToPath(new URL('./dist', import.meta.url))
      for (const name of developmentOnly) {
        const path = join(output, name)
        if (existsSync(path)) rmSync(path, { force: true })
      }
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), excludeDevelopmentAssets(), { name: 'dev-policy', transformIndexHtml(html, context) { return context.server ? html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*\/>/, '') : html } }],
  resolve: { dedupe: ['three'], alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: { host: '127.0.0.1', port: 5183, strictPort: true, hmr: { host: '127.0.0.1', port: 5183, protocol: 'ws' } },
})
