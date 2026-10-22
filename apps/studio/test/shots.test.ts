// Stored review images (decision #50): the app validates what the worker wrote, stores it as
// blobs, and the preview site (never the app) serves it under a signed link of its own kind.
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunRow } from '../server/checks/checks.ts'
import { isPng, shotsFor, storeShots } from '../server/checks/shots.ts'
import { createPreview } from '../server/preview/index.ts'
import { signReviewLink } from '../server/preview/review-link.ts'
import { signShotsToken, verifyShotsToken } from '../server/preview/shots-link.ts'
import type { StoreContext } from '../server/store/revisions.ts'

const secret = 'y'.repeat(40)
const appUrl = new URL('http://localhost:3000')
const previewUrl = new URL('http://localhost:3001')
const dataDir = mkdtempSync(join(tmpdir(), 'ss-shots-'))
afterAll(() => rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 }))

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(40, 7),
])
const ctx = { dataDir } as unknown as StoreContext
const RUN = '11111111-2222-3333-4444-555555555555'

function runWith(id: string, images: unknown, files: Record<string, Buffer>): RunRow {
  const dir = join(dataDir, 'checks', 'results', `${id}.images`)
  mkdirSync(dir, { recursive: true })
  for (const [n, b] of Object.entries(files)) writeFileSync(join(dir, n), b)
  return {
    id,
    project_id: 'go',
    rev: 'go-r1',
    hash: 'a'.repeat(64),
    kind: 'package',
    status: 'done',
    blocked: 0,
    result_json: JSON.stringify({ checks: [{ id: 'visual', status: 'warn', images }] }),
    error: null,
    rerun_of: null,
    at: new Date().toISOString(),
  }
}
const entry = (stem = 'index_html-1280') => ({
  page: 'index.html',
  width: 1280,
  baseline: `${stem}-baseline.png`,
  current: `${stem}-current.png`,
  diff: `${stem}-diff.png`,
})
const good = (stem = 'index_html-1280') => ({
  [`${stem}-baseline.png`]: PNG,
  [`${stem}-current.png`]: PNG,
  [`${stem}-diff.png`]: PNG,
})

describe('stored review images', () => {
  test('a real PNG is stored and served from the preview site only', async () => {
    const run = runWith(RUN, [entry()], good())
    const view = await shotsFor(ctx, { secret, url: previewUrl }, run)
    expect(view).toHaveLength(1)
    expect(view[0]?.path).toBe('')
    expect(view[0]?.baseline.startsWith(`${previewUrl.origin}/shots/`)).toBe(true)
    const preview = createPreview({ appUrl, appSecret: secret, dataDir })
    const r = await preview.request(new URL(view[0]?.diff as string).pathname)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('image/png')
    expect(r.headers.get('x-content-type-options')).toBe('nosniff')
    expect(r.headers.get('content-security-policy')).toContain("connect-src 'self'")
    expect(r.headers.get('set-cookie')).toBeNull()
    expect(Buffer.from(await r.arrayBuffer()).equals(PNG)).toBe(true)
  })

  test('a forged name, a traversal or an unlisted name is refused', async () => {
    const forged = runWith(
      '11111111-2222-3333-4444-555555555556',
      [
        { ...entry(), baseline: '../../project.json' },
        { ...entry('x-1280'), current: 'x-1280-baseline.png' }, // wrong kind for the key
        { ...entry('y-1280'), diff: 'y-1280-diff.png.exe' },
      ],
      good(),
    )
    expect(await storeShots(ctx, forged)).toBeNull()
    const preview = createPreview({ appUrl, appSecret: secret, dataDir })
    const token = signShotsToken(secret, { project: 'go', run: RUN })
    for (const n of ['other-1280-diff.png', '..%2Fproject.json', 'index_html-1280-diff.gif'])
      expect((await preview.request(`/shots/${token}/${n}`)).status).toBe(404)
  })

  test('a file that is not a PNG, or is too big, drops its page', async () => {
    const text = runWith('11111111-2222-3333-4444-555555555557', [entry('t-1280')], {
      ...good('t-1280'),
      't-1280-diff.png': Buffer.from('<script>alert(1)</script>'.padEnd(64, ' ')),
    })
    expect(await storeShots(ctx, text)).toBeNull()
    const big = runWith('11111111-2222-3333-4444-555555555558', [entry('b-1280')], {
      ...good('b-1280'),
      'b-1280-current.png': Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]),
    })
    expect(await storeShots(ctx, big)).toBeNull()
    expect(isPng(new Uint8Array(PNG))).toBe(true)
    expect(isPng(new Uint8Array(10))).toBe(false)
  })

  test('links are signed, expire, and are a kind of their own', async () => {
    const t = signShotsToken(secret, { project: 'go', run: RUN }, 1000)
    expect(verifyShotsToken(secret, t, 2000)?.run).toBe(RUN)
    expect(verifyShotsToken(secret, t, 1000 + 16 * 60 * 1000)).toBeNull() // expired
    expect(verifyShotsToken('z'.repeat(40), t, 2000)).toBeNull() // wrong key
    const [payload] = t.split('.')
    expect(verifyShotsToken(secret, `${payload}.AAAA`, 2000)).toBeNull() // forged signature
    const preview = createPreview({ appUrl, appSecret: secret, dataDir })
    const name = 'index_html-1280-diff.png'
    expect((await preview.request(`/shots/${t.replace(/.$/, 'x')}/${name}`)).status).toBe(404)
    // A review link does not open an image, and a shots link does not open a package.
    const review = signReviewLink(secret, { project: 'go', rev: 'go-r1', hash: 'a'.repeat(64) })
    const token = review.split('/')[2] as string
    expect((await preview.request(`/shots/${token}/${name}`)).status).toBe(404)
    expect((await preview.request(`/r/${t}/index.html`)).status).toBe(404)
    const fresh = signShotsToken(secret, { project: 'go', run: RUN })
    expect((await preview.request(`/shots/${fresh}/${name}`)).status).toBe(200)
  })
})
