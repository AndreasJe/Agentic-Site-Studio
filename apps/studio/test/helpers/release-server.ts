// The server for release.e2e.ts (run with Bun, cwd apps/studio): the real app on APP_PORT with the
// release fixture behind it (a staged revision, a folder target, the production agent on temp
// folders), plus a small control server on CONTROL_PORT that plays the parts outside the app: the
// deployment side's pairing file, the person at the server confirming its fingerprint, the worker
// and the agent's scan. The control server never signs anything; the browser does.
import { issueSetupCodes } from '../../server/auth/passkeys.ts'
import { pollAll } from '../../server/deploy/outbox.ts'
import { createPreview } from '../../server/preview/index.ts'
import { releaseFixture } from './release-fixture.ts'

const port = Number(process.argv[2] ?? 3151)
const controlPort = Number(process.argv[3] ?? port + 2)
const previewPort = port + 1
const f = await releaseFixture({
  appUrl: `http://localhost:${port}`,
  admins: [],
  pair: false,
  previewUrl: `http://127.0.0.1:${previewPort}`,
  shots: true,
})
const codes = issueSetupCodes(f.db, Date.now())

Bun.serve({ hostname: 'localhost', port, fetch: f.app.fetch })
// The preview site, a separate origin, so the review's stored images load from it (rule 4).
Bun.serve({
  hostname: '127.0.0.1',
  port: previewPort,
  fetch: createPreview({
    appUrl: new URL(`http://localhost:${port}`),
    appSecret: 'test-secret-for-release-tests',
    dataDir: f.dataDir,
  }).fetch,
})

let pending: Awaited<ReturnType<typeof f.pairStart>> | null = null
const json = (v: unknown, status = 200) => Response.json(v, { status })

Bun.serve({
  hostname: '127.0.0.1',
  port: controlPort,
  async fetch(req) {
    const path = new URL(req.url).pathname
    try {
      if (path === '/pair/start') {
        pending = await f.pairStart()
        return json({ challenge: pending.challenge, keyIds: pending.keyIds })
      }
      if (path === '/pair/finish' && pending) {
        const b = (await req.json()) as {
          keyId: string
          authenticatorData: string
          clientDataJSON: string
          signature: string
        }
        await f.pairFinish(pending.unsigned, b.keyId, b)
        return json({ paired: true })
      }
      if (path === '/stage') return json(await f.stageAndRequest('Ready for launch'))
      if (path === '/scan') {
        await f.agent.scan()
        await pollAll(f.ctx)
        const s = f.agent.snapshot()
        return json({ active: s.active, highestRelease: s.trust.highestRelease })
      }
      return json({ code: 'not-found' }, 404)
    } catch (e) {
      return json({ code: 'error', message: (e as Error).message }, 500)
    }
  },
})

process.on('SIGTERM', async () => {
  await f.cleanup()
  process.exit(0)
})
console.log(`setup ${JSON.stringify(codes)}`)
console.log(`ready ${port}`)
