import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'
import frontend from '../../frontend/vite.config.ts'

export default defineConfig({
  ...frontend,
  root: fileURLToPath(new URL('../../frontend', import.meta.url)),
  publicDir: false,
  base: '/app/',
  plugins: [
    ...frontend.plugins.filter(plugin => plugin?.name !== 'exclude-development-assets'),
    { name: 'rain-ui-preview', transformIndexHtml: html => html.replace('</head>', `<style>
      html,body,.scene-shell-root,.scene-shell{background:transparent!important}
      .scene-shell::before,.scene-wash,.live-stage-breath{display:none!important}
    </style></head>`) },
  ],
  resolve: { alias: [
    { find: '@/components/weather-rain', replacement: fileURLToPath(new URL('./ui-stage.tsx', import.meta.url)) },
    { find: '@/components/live-scene-stage', replacement: fileURLToPath(new URL('./ui-stage.tsx', import.meta.url)) },
    { find: '@/components/sky-effects', replacement: fileURLToPath(new URL('./ui-stage.tsx', import.meta.url)) },
    { find: '@', replacement: fileURLToPath(new URL('../../frontend/src', import.meta.url)) },
  ] },
  build: { outDir: fileURLToPath(new URL('../../build/rain-ui-preview', import.meta.url)), emptyOutDir: true },
})
