// M1 step 6: projects API, private drafts, versions and saving (M1 Done when; decision #41).
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
  const dataDir = mkdtempSync(join(tmpdir(), 'studio-drafts-'))
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
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await app.request(`${APP}${path}`, {
        method,
        headers: { origin: APP, 'content-type': 'application/json', cookie, 'x-csrf-token': csrf },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      return { status: r.status, body: (await r.json()) as Record<string, unknown> }
    }
    return call
  }
  return { db, dataDir, as }
}

describe('projects', () => {
  test('a Creator creates a project and is its member; a taken ID gets a suggestion', async () => {
    const { as } = await setup()
    const alex = await as('alex')
    expect(await alex('POST', '/api/projects', { name: 'QualiWare GO' })).toMatchObject({
      status: 201,
      body: { id: 'qualiwarego' },
    })
    expect(await alex('POST', '/api/projects', { name: 'QualiWare GO' })).toMatchObject({
      status: 409,
      body: { code: 'slug-taken', suggested: 'qualiwarego2' },
    })
    const list = await alex('GET', '/api/projects')
    expect((list.body.projects as { id: string }[]).map((p) => p.id)).toEqual(['qualiwarego'])
  })

  test('a Creator who is not a member sees neither the project nor its draft', async () => {
    const { as } = await setup()
    await (await as('alex'))('POST', '/api/projects', { name: 'Secret' })
    const rune = await as('rune')
    expect((await rune('GET', '/api/projects')).body.projects).toEqual([])
    expect((await rune('GET', '/api/p/secret/draft')).status).toBe(404)
  })
})

describe('drafts', () => {
  test('two people edit from r3 at once; both save; r4 and r5 both have parent r3; nothing is lost', async () => {
    const { as, db, dataDir } = await setup()
    const alex = await as('alex')
    const rune = await as('rune')
    await alex('POST', '/api/projects', { name: 'Go' })
    db.query(
      "insert into members (project_id, user_id) select 'go', id from users where handle = 'rune'",
    ).run()
    for (let i = 1; i <= 3; i++) {
      await alex('PUT', '/api/p/go/draft', { files: { 'brief.json': `{"v":${i}}` } })
      await alex('POST', '/api/p/go/draft/save', { msg: `step ${i}` })
    }
    // Both now start from r3, the current revision.
    expect((await rune('GET', '/api/p/go/draft')).body).toMatchObject({ base: 'go-r3' })
    await alex('PUT', '/api/p/go/draft', { files: { 'brief.json': '{"by":"alex"}' } })
    await rune('PUT', '/api/p/go/draft', {
      files: { 'brief.json': '{"by":"rune"}', 'notes.txt': 'rune' },
    })
    const [a, r] = await Promise.all([
      alex('POST', '/api/p/go/draft/save', { msg: 'Alex edit' }),
      rune('POST', '/api/p/go/draft/save', { msg: 'Rune edit' }),
    ])
    const saved = [a.body.revision, r.body.revision].sort()
    expect(saved).toEqual(['go-r4', 'go-r5'])
    const revision = (id: unknown) =>
      JSON.parse(readFileSync(join(dataDir, 'go/revisions', `${id}.json`), 'utf8'))
    expect(revision(a.body.revision).parent).toBe('go-r3')
    expect(revision(r.body.revision).parent).toBe('go-r3')
    // The second to save was based on an older revision and is warned (decision #41).
    expect([a.body.warning, r.body.warning].filter(Boolean)).toEqual(['base-not-current'])
    // Nothing lost: each revision holds its author's files.
    expect(Object.keys(revision(r.body.revision).files).sort()).toEqual(['brief.json', 'notes.txt'])
    expect(revision(a.body.revision).files['brief.json']).not.toBe(
      revision(r.body.revision).files['brief.json'],
    )
  })

  test('a draft is visible only to its owner', async () => {
    const { as, db } = await setup()
    const alex = await as('alex')
    const rune = await as('rune')
    await alex('POST', '/api/projects', { name: 'Private' })
    db.query(
      "insert into members (project_id, user_id) select 'private', id from users where handle = 'rune'",
    ).run()
    await alex('PUT', '/api/p/private/draft', { files: { 'brief.json': '{"secret":true}' } })
    expect(
      ((await rune('GET', '/api/p/private/draft')).body.files as Record<string, string>)[
        'brief.json'
      ],
    ).toBeUndefined()
    expect(
      ((await alex('GET', '/api/p/private/draft')).body.files as Record<string, string>)[
        'brief.json'
      ],
    ).toBe('{"secret":true}')
  })

  test('every autosave makes a version; saving needs a message; discarding empties the draft', async () => {
    const { as, db } = await setup()
    const alex = await as('alex')
    await alex('POST', '/api/projects', { name: 'Versions' })
    for (let i = 0; i < 3; i++)
      await alex('PUT', '/api/p/versions/draft', { files: { 'a.txt': `${i}` } })
    expect(db.query('select count(*) as n from versions').get()).toEqual({ n: 3 })
    expect((await alex('POST', '/api/p/versions/draft/save', { msg: ' ' })).status).toBe(400)
    expect((await alex('DELETE', '/api/p/versions/draft')).status).toBe(200)
    expect((await alex('GET', '/api/p/versions/draft')).body.files).toEqual({})
  })
})
