// M4 step 3: the Media library (plan §6.8): two levels, upload checks, metadata, replace, block,
// archive, licence expiry.

import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../server/app/index.ts'
import { seedTestAccounts } from '../server/auth/seed.ts'
import { createSession, SESSION_COOKIE } from '../server/auth/sessions.ts'
import { openDb } from '../server/db/index.ts'
import { expiryStatus, recordUse } from '../server/media/media.ts'
import { validGif, validJpeg, validPng, validWebp } from './helpers/images.ts'

const APP = 'http://localhost:3000'
const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

// Valid minimal images: the M8 stripper refuses truncated files.
const PNG = (extra = 0) => validPng(extra)
const JPEG = validJpeg()
const GIF = validGif()
const WEBP = validWebp()
const svg = (inner: string) =>
  new TextEncoder().encode(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${inner}</svg>`,
  )

// biome-ignore lint/suspicious/noExplicitAny: test responses are loosely typed
type Json = any

async function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'studio-media-'))
  dirs.push(dataDir)
  const db = openDb(':memory:')
  seedTestAccounts(db)
  const app = createApp({ appUrl: new URL(APP), instanceId: 'qw', db, dataDir })
  const as = (handle: string) => {
    const user = db.query('select id from users where handle = ?').get(handle) as { id: number }
    const s = createSession(db, user.id, Date.now())
    const headers = {
      origin: APP,
      cookie: `${SESSION_COOKIE}=${s.id}`,
      'x-csrf-token': s.csrf,
    }
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await app.request(`${APP}${path}`, {
        method,
        headers: { ...headers, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      return { status: r.status, body: (await r.json().catch(() => ({}))) as Json }
    }
    const upload = async (
      path: string,
      name: string,
      bytes: Uint8Array,
      fields: Record<string, string> = {},
    ) => {
      const form = new FormData()
      form.append('file', new File([bytes as Uint8Array<ArrayBuffer>], name))
      for (const [k, v] of Object.entries(fields)) form.append(k, v)
      const r = await app.request(`${APP}${path}`, { method: 'POST', headers, body: form })
      return { status: r.status, body: (await r.json().catch(() => ({}))) as Json }
    }
    const raw = (path: string) => app.request(`${APP}${path}`, { headers })
    return { call, upload, raw }
  }
  const alex = as('alex')
  const rune = as('rune')
  const admin = as('admina')
  await alex.call('POST', '/api/projects', { name: 'Go' })
  return { dataDir, db, alex, rune, admin }
}

const blobPath = (dataDir: string, project: string | null, hash: string) => {
  const x = hash.slice('sha256:'.length)
  const root = project ? join(dataDir, project) : join(dataDir, 'media')
  return join(root, 'blobs', 'sha256', x.slice(0, 2), x.slice(2))
}

describe('media: two levels and membership', () => {
  test('anyone signed in reads the organisation library; only an Admin writes to it', async () => {
    const { alex, admin } = await setup()
    const denied = await alex.upload('/api/media', 'a.png', PNG())
    expect(denied.status).toBe(403)
    const ok = await admin.upload('/api/media', 'a.png', PNG(), { title: 'Logo' })
    expect(ok.status).toBe(201)
    const list = await alex.call('GET', '/api/media')
    expect(list.status).toBe(200)
    expect(list.body.items.map((i: { title: string }) => i.title)).toEqual(['Logo'])
    // A Creator cannot change, block, replace or archive it either.
    const id = ok.body.item.id
    expect((await alex.call('PUT', `/api/media/${id}`, { title: 'x' })).status).toBe(403)
    expect((await alex.call('POST', `/api/media/${id}/block`)).status).toBe(403)
    expect((await alex.call('POST', `/api/media/${id}/archive`)).status).toBe(403)
    expect((await alex.upload(`/api/media/${id}/replace`, 'b.png', PNG(1))).status).toBe(403)
    // Reading the file works for any signed-in person.
    expect((await alex.raw(`/api/media/${id}/file`)).status).toBe(200)
  })

  test('the project library is for members (and Admins)', async () => {
    const { alex, rune, admin } = await setup()
    const up = await alex.upload('/api/p/go/media', 'a.png', PNG())
    expect(up.status).toBe(201)
    expect((await rune.call('GET', '/api/p/go/media')).status).toBe(404)
    expect((await rune.upload('/api/p/go/media', 'a.png', PNG())).status).toBe(404)
    expect((await rune.raw(`/api/p/go/media/${up.body.item.id}/file`)).status).toBe(404)
    expect((await admin.call('GET', '/api/p/go/media')).status).toBe(200)
    // The two libraries are separate.
    expect((await alex.call('GET', '/api/media')).body.items).toEqual([])
    expect((await alex.call('GET', `/api/media/${up.body.item.id}`)).status).toBe(404)
  })

  test('the upload is refused without a file, and is limited to 20 MB', async () => {
    const { alex } = await setup()
    expect((await alex.call('POST', '/api/p/go/media', {})).status).toBe(400)
    const big = new Uint8Array(21 * 1024 * 1024)
    big.set(PNG())
    expect((await alex.upload('/api/p/go/media', 'big.png', big)).status).toBe(413)
  })
})

describe('media: type checks', () => {
  test('png, jpeg, webp, gif and svg are accepted, by their bytes', async () => {
    const { alex } = await setup()
    const mimes: string[] = []
    for (const [n, b] of [
      ['a.png', PNG()],
      ['b.jpg', JPEG],
      ['c.webp', WEBP],
      ['d.gif', GIF],
      ['e.svg', svg('<rect width="4" height="4"/>')],
    ] as const) {
      const r = await alex.upload('/api/p/go/media', n, b)
      expect(r.status).toBe(201)
      mimes.push(r.body.item.mime)
    }
    expect(mimes).toEqual(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml'])
  })

  test('the extension and the claimed type do not matter, only the bytes', async () => {
    const { alex } = await setup()
    const text = await alex.upload('/api/p/go/media', 'a.png', new TextEncoder().encode('hello'))
    expect(text.status).toBe(415)
    const exe = await alex.upload('/api/p/go/media', 'a.png', new Uint8Array([0x4d, 0x5a, 0, 0]))
    expect(exe.status).toBe(415)
    const html = await alex.upload(
      '/api/p/go/media',
      'a.svg',
      new TextEncoder().encode('<html><script>1</script></html>'),
    )
    expect(html.status).toBe(415)
    // A real PNG named .exe is still a PNG.
    expect((await alex.upload('/api/p/go/media', 'a.exe', PNG())).status).toBe(201)
  })

  test('svg with scripts, handlers, foreignObject or external references is refused', async () => {
    const { alex } = await setup()
    const bad = [
      '<script>alert(1)</script>',
      '<SCRIPT src="x.js"></SCRIPT>',
      '<rect onload="x()" width="1" height="1"/>',
      '<rect onClick = "x()" width="1" height="1"/>',
      '<foreignObject><div/></foreignObject>',
      '<image href="https://evil.example/a.png"/>',
      '<use xlink:href="http://evil.example/a.svg#x"/>',
      '<a href="javascript:alert(1)"><rect/></a>',
      '<rect style="fill:url(https://evil.example/x)"/>',
      // review of M4: prefixed elements and animated script URLs
      '<x:script xmlns:x="http://www.w3.org/2000/svg">alert(1)</x:script>',
      '<x:foreignObject xmlns:x="http://www.w3.org/2000/svg"><div/></x:foreignObject>',
      '<a><set attributeName="href" to="javascript:alert(1)"/><rect/></a>',
      '<use x:href="https://evil.example/a.svg#x"/>',
    ]
    for (const inner of bad) {
      const r = await alex.upload('/api/p/go/media', 'x.svg', svg(inner))
      expect({ inner, status: r.status }).toEqual({ inner, status: 422 })
      expect(r.body.code).toBe('unsafe-svg')
    }
    // Internal references are fine.
    const ok = await alex.upload(
      '/api/p/go/media',
      'x.svg',
      svg('<defs><g id="a"><rect width="1" height="1"/></g></defs><use href="#a"/>'),
    )
    expect(ok.status).toBe(201)
  })
})

describe('media: metadata, replace, block, archive', () => {
  test('metadata is edited and validated', async () => {
    const { alex } = await setup()
    const up = await alex.upload('/api/p/go/media', 'hero-image.png', PNG())
    expect(up.body.item.title).toBe('hero-image')
    expect(up.body.item.category).toBe('free')
    const id = up.body.item.id
    const put = await alex.call('PUT', `/api/p/go/media/${id}`, {
      title: 'Hero',
      alt: 'A boat at sea',
      category: 'customer-logo',
      subject: 'Coop',
      rights: 'Photographer X, licence 123',
      allowedUse: 'Customer story pages',
      licenceExpires: '2030-01-31',
    })
    expect(put.status).toBe(200)
    expect(put.body.item).toMatchObject({
      title: 'Hero',
      alt: 'A boat at sea',
      category: 'customer-logo',
      subject: 'Coop',
      licenceExpires: '2030-01-31',
    })
    expect((await alex.call('PUT', `/api/p/go/media/${id}`, { category: 'nope' })).status).toBe(400)
    expect((await alex.call('PUT', `/api/p/go/media/${id}`, { title: '  ' })).status).toBe(400)
    expect(
      (await alex.call('PUT', `/api/p/go/media/${id}`, { licenceExpires: '2030-02-31' })).status,
    ).toBe(400)
    const cleared = await alex.call('PUT', `/api/p/go/media/${id}`, { licenceExpires: null })
    expect(cleared.body.item.licenceExpires).toBeNull()
    expect((await alex.call('PUT', '/api/p/go/media/9999', { title: 'x' })).status).toBe(404)
  })

  test('replace stores a new blob and keeps the old file', async () => {
    const { alex, dataDir } = await setup()
    const up = await alex.upload('/api/p/go/media', 'a.png', PNG(1))
    const id = up.body.item.id
    const first = up.body.item.hash as string
    const rep = await alex.upload(`/api/p/go/media/${id}/replace`, 'b.jpg', JPEG)
    expect(rep.status).toBe(200)
    expect(rep.body.item.hash).not.toBe(first)
    expect(rep.body.item.mime).toBe('image/jpeg')
    expect(rep.body.item.versions).toHaveLength(2)
    expect(existsSync(blobPath(dataDir, 'go', first))).toBe(true)
    expect(existsSync(blobPath(dataDir, 'go', rep.body.item.hash))).toBe(true)
    // The served file is the new one; a refused replacement changes nothing.
    const served = new Uint8Array(
      await (await alex.raw(`/api/p/go/media/${id}/file`)).arrayBuffer(),
    )
    expect(Buffer.from(served).equals(Buffer.from(JPEG))).toBe(true)
    const bad = await alex.upload(
      `/api/p/go/media/${id}/replace`,
      'c.png',
      new Uint8Array([1, 2, 3]),
    )
    expect(bad.status).toBe(415)
    expect((await alex.call('GET', `/api/p/go/media/${id}`)).body.item.hash).toBe(
      rep.body.item.hash,
    )
  })

  test('the organisation library stores under DATA_DIR/media', async () => {
    const { admin, dataDir } = await setup()
    const up = await admin.upload('/api/media', 'a.png', PNG())
    expect(existsSync(blobPath(dataDir, null, up.body.item.hash))).toBe(true)
  })

  test('block and unblock', async () => {
    const { alex } = await setup()
    const id = (await alex.upload('/api/p/go/media', 'a.png', PNG())).body.item.id
    expect((await alex.call('POST', `/api/p/go/media/${id}/block`)).body.item.blocked).toBe(true)
    expect((await alex.call('POST', `/api/p/go/media/${id}/unblock`)).body.item.blocked).toBe(false)
  })

  test('archive hides the item but keeps the blob; nothing is deleted', async () => {
    const { alex, dataDir } = await setup()
    const up = await alex.upload('/api/p/go/media', 'a.png', PNG())
    const id = up.body.item.id
    const path = blobPath(dataDir, 'go', up.body.item.hash)
    const before = readFileSync(path)
    expect((await alex.call('POST', `/api/p/go/media/${id}/archive`)).body.item.archived).toBe(true)
    expect((await alex.call('GET', '/api/p/go/media')).body.items).toEqual([])
    expect((await alex.call('GET', '/api/p/go/media?archived=1')).body.items).toHaveLength(1)
    expect(readFileSync(path)).toEqual(before)
    // It cannot be edited or replaced while archived, but it can be restored.
    expect((await alex.call('PUT', `/api/p/go/media/${id}`, { title: 'x' })).status).toBe(409)
    expect((await alex.upload(`/api/p/go/media/${id}/replace`, 'b.png', PNG(2))).status).toBe(409)
    expect((await alex.call('POST', `/api/p/go/media/${id}/unarchive`)).body.item.archived).toBe(
      false,
    )
    expect((await alex.call('GET', '/api/p/go/media')).body.items).toHaveLength(1)
  })

  test('used in is empty until design records a use', async () => {
    const { alex, db } = await setup()
    const id = (await alex.upload('/api/p/go/media', 'a.png', PNG())).body.item.id
    expect((await alex.call('GET', `/api/p/go/media/${id}`)).body.item.usedIn).toEqual([])
    recordUse(db, id, 'go-r1:/index.html#hero')
    recordUse(db, id, 'go-r1:/index.html#hero')
    expect((await alex.call('GET', `/api/p/go/media/${id}`)).body.item.usedIn).toEqual([
      'go-r1:/index.html#hero',
    ])
  })
})

describe('media: licence expiry', () => {
  const now = Date.parse('2026-10-21T12:00:00Z')
  test('expired and expiring within 30 days are flagged', () => {
    expect(expiryStatus(null, now)).toBeNull()
    expect(expiryStatus('2026-10-20', now)).toBe('expired')
    expect(expiryStatus('2026-10-21', now)).toBe('expiring')
    expect(expiryStatus('2026-11-20', now)).toBe('expiring')
    expect(expiryStatus('2026-11-21', now)).toBeNull()
    expect(expiryStatus('2027-06-01', now)).toBeNull()
  })

  test('the list carries the flag', async () => {
    const { alex } = await setup()
    const ymd = (offset: number) =>
      new Date(Date.now() + offset * 86400_000).toISOString().slice(0, 10)
    const mk = async (name: string, d: string | null) => {
      const r = await alex.upload('/api/p/go/media', `${name}.png`, PNG(name.length), {
        ...(d ? { licenceExpires: d } : {}),
      })
      expect(r.status).toBe(201)
    }
    await mk('past', ymd(-3))
    await mk('soon', ymd(10))
    await mk('later', ymd(90))
    await mk('never', null)
    const items = (await alex.call('GET', '/api/p/go/media')).body.items as {
      title: string
      expiry: string | null
    }[]
    const by = Object.fromEntries(items.map((i) => [i.title, i.expiry]))
    expect(by).toEqual({ past: 'expired', soon: 'expiring', later: null, never: null })
  })
})
