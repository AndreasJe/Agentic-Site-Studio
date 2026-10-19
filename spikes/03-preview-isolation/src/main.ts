// Starts the app, the preview and a decoy "LAN" host, each on its own port.
// APP_PORT, PREVIEW_PORT, LAN_PORT; PREVIEW_CSP=off turns the package CSP header off.
import { startApp } from './app.ts'
import { startPreview } from './preview.ts'
import { packageHash, REVISIONS } from './revisions.ts'

const appPort = Number(process.env.APP_PORT ?? 3301)
const previewPort = Number(process.env.PREVIEW_PORT ?? 3302)
const lanPort = Number(process.env.LAN_PORT ?? 3303)
const appOrigin = `http://localhost:${appPort}`
const previewOrigin = `http://127.0.0.1:${previewPort}`
const log = (who: string) => (entry: Record<string, unknown>) =>
  console.log(`LOG ${who} ${JSON.stringify(entry)}`)

startApp({
  port: appPort,
  appOrigin,
  previewOrigin,
  revisions: Object.fromEntries(
    Object.entries(REVISIONS).map(([rev, r]) => [
      rev,
      { sections: r.sections, hash: packageHash(r.dir) },
    ]),
  ),
  log: log('app'),
})
startPreview({
  port: previewPort,
  appOrigin,
  packages: Object.fromEntries(Object.entries(REVISIONS).map(([rev, r]) => [rev, r.dir])),
  csp: process.env.PREVIEW_CSP !== 'off',
})
// Another host on the network: anything that reaches it is logged.
const lanLog = log('lan')
Bun.serve({
  port: lanPort,
  fetch(req, server) {
    const path = new URL(req.url).pathname
    lanLog({ method: req.method, path, origin: req.headers.get('origin') })
    if (path === '/ws' && server.upgrade(req)) return undefined
    return new Response('lan')
  },
  websocket: { message() {} },
})
console.log(`listening app ${appOrigin} preview ${previewOrigin} lan http://127.0.0.1:${lanPort}`)
