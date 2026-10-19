// M1 step 8: the revisions API (timeline, read-only view, continue from here, archive).
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../server/app/index.ts'
import { seedTestAccounts } from '../server/auth/seed.ts'
import { openDb } from '../server/db/index.ts'

const APP = 'http://localhost:3000'
const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

async function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'studio-revapi-'))
  dirs.push(dataDir)
  const db = openDb(':memory:')
  seedTestAccounts(db)
  const app = createApp({ appUrl: new URL(APP), instanceId: 'qw-office', db, dataDir })
  const as = async (handle: string) => {
    const res = await app.request(`${APP}/api/sign-in`, {
      method: 'POST',
      headers: { origin: APP, 'content-type': 'application/json' },
      body: JSON.stringify({ handle, password: handle }),
    })
    const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
    const { csrf } = (await res.json()) as { csrf: string }
    return async (method: string, path: string, body?: unknown) => {
      const r = await app.request(`${APP}${path}`, {
        method,
        headers: { origin: APP, 'content-type': 'application/json', cookie, 'x-csrf-token': csrf },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      return { status: r.status, body: (await r.json()) as Record<string, unknown> }
    }
  }
  // A project with three revisions by alex.
  const alex = await as('alex')
  await alex('POST', '/api/projects', { name: 'Go' })
  for (let i = 1; i <= 3; i++) {
    await alex('PUT', '/api/p/go/draft', { files: { 'brief.json': `{"v":${i}}`, 'a.txt': 'same' } })
    await alex('POST', '/api/p/go/draft/save', { msg: `step ${i}` })
  }
  return { db, dataDir, as, alex }
}

type Timeline = { id: string; parent: string | null; by: string; msg: string; archived: boolean }[]

describe('revisions API', () => {
  test('the timeline is newest first, with parents and archived flags', async () => {
    const { alex } = await setup()
    const res = await alex('GET', '/api/p/go/revisions')
    expect(res.status).toBe(200)
    const list = res.body.revisions as Timeline
    expect(list.map((r) => r.id)).toEqual(['go-r3', 'go-r2', 'go-r1'])
    expect(list[0]).toMatchObject({ parent: 'go-r2', by: 'alex', msg: 'step 3', archived: false })
    expect(res.body.current).toBe('go-r3')
  })

  test('a non-member gets 404 on every revisions route', async () => {
    const { as } = await setup()
    const rune = await as('rune')
    expect((await rune('GET', '/api/p/go/revisions')).status).toBe(404)
    expect((await rune('GET', '/api/p/go/revisions/go-r1')).status).toBe(404)
    expect((await rune('POST', '/api/p/go/revisions/go-r1/continue')).status).toBe(404)
    expect(
      (await rune('POST', '/api/p/go/revisions/go-r1/archive', { archived: true })).status,
    ).toBe(404)
  })

  test('one revision is readable with its files; unknown or foreign IDs are 404', async () => {
    const { alex } = await setup()
    const res = await alex('GET', '/api/p/go/revisions/go-r2')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      id: 'go-r2',
      parent: 'go-r1',
      files: { 'brief.json': '{"v":2}', 'a.txt': 'same' },
    })
    expect((await alex('GET', '/api/p/go/revisions/go-r9')).status).toBe(404)
    expect((await alex('GET', '/api/p/go/revisions/other-r1')).status).toBe(404)
    expect((await alex('GET', '/api/p/go/revisions/..%2Fproject')).status).toBe(404)
  })

  test('continue from go-r1 makes go-r4 with parent go-r1 and the old files; the draft is based on it', async () => {
    const { alex } = await setup()
    const res = await alex('POST', '/api/p/go/revisions/go-r1/continue')
    expect(res.status).toBe(201)
    expect(res.body.revision).toBe('go-r4')
    const r4 = await alex('GET', '/api/p/go/revisions/go-r4')
    expect(r4.body).toMatchObject({ parent: 'go-r1', files: { 'brief.json': '{"v":1}' } })
    expect((await alex('GET', '/api/p/go/draft')).body).toMatchObject({ base: 'go-r4' })
    // Newer revisions stay.
    const list = (await alex('GET', '/api/p/go/revisions')).body.revisions as Timeline
    expect(list.map((r) => r.id)).toEqual(['go-r4', 'go-r3', 'go-r2', 'go-r1'])
  })

  test('archive hides and shows a revision; nothing is deleted', async () => {
    const { alex, db, dataDir } = await setup()
    expect(
      (await alex('POST', '/api/p/go/revisions/go-r2/archive', { archived: true })).status,
    ).toBe(200)
    let list = (await alex('GET', '/api/p/go/revisions')).body.revisions as Timeline
    expect(list.map((r) => [r.id, r.archived])).toEqual([
      ['go-r3', false],
      ['go-r2', true],
      ['go-r1', false],
    ])
    expect(
      JSON.parse(
        (db.query("select archived from projects where id = 'go'").get() as { archived: string })
          .archived,
      ),
    ).toEqual(['go-r2'])
    expect(existsSync(join(dataDir, 'go/revisions/go-r2.json'))).toBe(true)
    expect((await alex('GET', '/api/p/go/revisions/go-r2')).status).toBe(200)
    await alex('POST', '/api/p/go/revisions/go-r2/archive', { archived: true }) // idempotent
    await alex('POST', '/api/p/go/revisions/go-r2/archive', { archived: false })
    list = (await alex('GET', '/api/p/go/revisions')).body.revisions as Timeline
    expect(list.every((r) => !r.archived)).toBe(true)
  })

  test('archive needs a boolean and an existing revision', async () => {
    const { alex } = await setup()
    expect(
      (await alex('POST', '/api/p/go/revisions/go-r2/archive', { archived: 'yes' })).status,
    ).toBe(400)
    expect(
      (await alex('POST', '/api/p/go/revisions/go-r9/archive', { archived: true })).status,
    ).toBe(404)
  })
})
