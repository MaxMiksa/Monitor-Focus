import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'
import { createReadStream, statSync } from 'node:fs'
import { resolve, sep } from 'node:path'

const appRoot = fileURLToPath(new URL('../../build/rain-ui-preview', import.meta.url))
const productRoot = fileURLToPath(new URL('../../frontend/dist', import.meta.url))
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }
function mountStatic(server, prefix, directory) {
  server.middlewares.use(prefix, (request, response, next) => {
    let path
    try { path = resolve(directory, '.' + decodeURIComponent(new URL(request.url, 'http://localhost').pathname)) }
    catch { response.statusCode = 400; response.end(); return }
    if (path !== directory && !path.startsWith(directory + sep)) { response.statusCode = 403; response.end(); return }
    if (path === directory) path = resolve(directory, 'index.html')
    try { if (!statSync(path).isFile()) return next() } catch { response.statusCode = 404; response.end('Build the preview resources first'); return }
    const extension = path.slice(path.lastIndexOf('.'))
    response.setHeader('Content-Type', types[extension] || 'application/octet-stream')
    response.setHeader('Cache-Control', 'no-store')
    createReadStream(path).pipe(response)
  })
}

export default defineConfig({
  plugins: [{ name: 'actual-ui-preview', configureServer(server) {
    mountStatic(server, '/app', appRoot)
    mountStatic(server, '/product', productRoot)
    mountStatic(server, '/assets', resolve(productRoot, 'assets'))
  } }],
  publicDir: fileURLToPath(new URL('../../frontend/public', import.meta.url)),
  server: { host: '127.0.0.1', port: 5194, strictPort: true, fs: { allow: [fileURLToPath(new URL('../..', import.meta.url))] } },
})
