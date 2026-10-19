import { join, relative } from 'node:path'
import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'

const CLIENT_DIST = join(import.meta.dir, '..', '..', 'client', 'dist')

export type AppOptions = { appUrl: URL; instanceId: string; clientDist?: string }

export function createApp({ instanceId, clientDist = CLIENT_DIST }: AppOptions) {
  const app = new Hono()
  // serveStatic wants a path relative to the cwd
  const root = relative(process.cwd(), clientDist) || '.'

  app.get('/api/health', (c) => c.json({ ok: true, instanceId }))
  app.all('/api/*', (c) => c.json({ error: 'not_found' }, 404))
  app.use('*', serveStatic({ root }))
  app.get('*', serveStatic({ root, path: 'index.html' }))
  return app
}
