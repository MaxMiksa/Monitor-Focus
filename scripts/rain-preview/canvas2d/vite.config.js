// An isolated build of the actual panel: replace only the two optional effects.
import { defineConfig } from 'vite'
import { cpSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import frontend from '../../../frontend/vite.config.ts'
const file = (path) => fileURLToPath(new URL(path, import.meta.url))
const batch = process.env.FLAT_BATCH === '1'
const outDir = file(batch ? '../../../build/effects-2d-batch' : '../../../build/effects-2d-preview')
export default defineConfig({
    ...frontend,
    root: file('../../../frontend'),
    publicDir: false,
    plugins: [
        ...frontend.plugins.filter((p) => p?.name !== 'exclude-development-assets'),
        {
            name: 'flat-preview-media',
            writeBundle() {
                for (const name of ['scenes', 'favicon.svg', 'third-party-notices.txt'])
                    cpSync(file('../../../frontend/public/' + name), join(outDir, name), { recursive: true })
            },
        },
    ],
    resolve: {
        ...frontend.resolve,
        dedupe: ['react', 'react-dom', 'three'],
        alias: [
            ...(batch ? [{ find: './rain-painter.js', replacement: file('./rain-batch.js') }] : []),
            { find: '@/lib/wind-rain-runtime.js', replacement: file('./rain.js') },
            { find: './sky-canvas', replacement: file('./sky.jsx') },
            { find: '@', replacement: file('../../../frontend/src') },
        ],
    },
    build: { outDir, emptyOutDir: true },
})
