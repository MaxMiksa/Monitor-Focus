import { createServer } from 'vite'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
const server = await createServer({ root: fileURLToPath(new URL('.', import.meta.url)) })
await server.listen()
server.printUrls()
const input = createInterface({ input: process.stdin })
input.on('line', async line => { if (line.trim() === 'exit') { await server.close(); input.close() } })
process.on('SIGINT', async () => { await server.close(); input.close() })
