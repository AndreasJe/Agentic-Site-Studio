// Static server for one package. Sends the contract CSP, serves bytes unchanged.
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const CSP_FILE = fileURLToPath(new URL('../../../contracts/csp.txt', import.meta.url))
// The contract has a placeholder for the approved video host. No host is approved here.
export const CSP = readFileSync(CSP_FILE, 'utf8')
  .trim()
  .replace('<approved video platform host>', "'none'")

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.woff2': 'font/woff2',
  '.glb': 'model/gltf-binary',
}

export function servePackage(root) {
  const base = resolve(root)
  const server = createServer((req, res) => {
    let path
    try {
      path = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    } catch {
      res.writeHead(400).end()
      return
    }
    if (path.endsWith('/')) path += 'index.html'
    const file = normalize(join(base, path))
    if (file !== base && !file.startsWith(base + sep)) {
      res.writeHead(403).end()
      return
    }
    let bytes
    try {
      bytes = readFileSync(file)
    } catch {
      res.writeHead(404, { 'content-security-policy': CSP }).end('not found')
      return
    }
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'content-security-policy': CSP,
      'cache-control': 'no-store',
    })
    res.end(bytes)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(r)),
      }),
    )
  })
}
