// M2 step 1: the brief store (plan §4.1–4.6; decision #42; M2 Done when).
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../server/app/index.ts'
import { seedTestAccounts } from '../server/auth/seed.ts'
import {
  approve,
  BLOCK_KEYS,
  emptyBrief,
  normalizeBrief,
  openQuestions,
  setBlock,
} from '../server/brief/brief.ts'
import { openDb } from '../server/db/index.ts'

const APP = 'http://localhost:3000'
const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

const by = { kind: 'user' as const, by: 'alex', at: '2026-10-19T10:00:00Z' }

describe('the brief document', () => {
  test('a new brief has every block, all "Not set yet."', () => {
    const b = emptyBrief({ id: 'alex1', title: 'Go', author: 'alex' })
    expect(b.blocks.map((x) => x.key)).toEqual(BLOCK_KEYS)
    expect(openQuestions(b)).toEqual(BLOCK_KEYS)
  })

  test('a field without a source is rejected and becomes "Not set yet."', () => {
    const b = emptyBrief({ id: 'alex1', title: 'Go', author: 'alex' })
    const raw = {
      ...b,
      blocks: b.blocks.map((x) =>
        x.key === 'audience' ? { key: 'audience', state: 'filled', text: 'CIOs' } : x,
      ),
    }
    const n = normalizeBrief(raw)
    expect(n.blocks.find((x) => x.key === 'audience')).toEqual({
      key: 'audience',
      state: 'not_set',
    })
    expect(openQuestions(n)).toContain('audience')
  })

  test('a filled block with text and source stays filled; blank text is not set', () => {
    let b = emptyBrief({ id: 'alex1', title: 'Go', author: 'alex' })
    b = setBlock(b, 'audience', { text: 'CIOs and enterprise architects', source: by })
    expect(b.blocks.find((x) => x.key === 'audience')).toMatchObject({
      state: 'filled',
      source: { kind: 'user' },
    })
    b = setBlock(b, 'audience', { text: '   ', source: by })
    expect(b.blocks.find((x) => x.key === 'audience')?.state).toBe('not_set')
  })

  test('only one primary call to action is allowed; a target may be left empty', () => {
    const b = emptyBrief({ id: 'alex1', title: 'Go', author: 'alex' })
    const ok = setBlock(b, 'calls_to_action', {
      text: 'Book a demo',
      source: by,
      ctas: [
        { label: 'Book a demo', target: '', priority: 'primary' },
        { label: 'Start a trial', target: 'https://example.com/trial', priority: 'secondary' },
      ],
    })
    expect(ok.blocks.find((x) => x.key === 'calls_to_action')?.ctas).toHaveLength(2)
    expect(() =>
      setBlock(b, 'calls_to_action', {
        text: 'x',
        source: by,
        ctas: [
          { label: 'A', target: '', priority: 'primary' },
          { label: 'B', target: '', priority: 'primary' },
        ],
      }),
    ).toThrow('one primary')
    expect(() =>
      setBlock(b, 'calls_to_action', {
        text: 'x',
        source: by,
        ctas: [{ label: 'A', target: 'http://x.com', priority: 'primary' }],
      }),
    ).toThrow('target')
  })

  test('open questions never block approval, even when approval is Required', () => {
    const b = emptyBrief({ id: 'alex1', title: 'Go', author: 'alex' })
    expect(openQuestions(b).length).toBe(10)
    expect(approve(b, 'required').status).toBe('approved')
    expect(approve(b, 'optional').status).toBe('approved')
    expect(() => approve(b, 'off')).toThrow('off')
  })

  test('an edit after approval puts the brief back to draft', () => {
    const b = approve(emptyBrief({ id: 'alex1', title: 'Go', author: 'alex' }), 'required')
    expect(setBlock(b, 'scope', { text: 'A whole site', source: by }).status).toBe('draft')
  })
})

describe('the brief API', () => {
  async function setup() {
    const dataDir = mkdtempSync(join(tmpdir(), 'studio-brief-'))
    dirs.push(dataDir)
    const db = openDb(':memory:')
    seedTestAccounts(db)
    const app = createApp({ appUrl: new URL(APP), instanceId: 'qw', db, dataDir })
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
          headers: {
            origin: APP,
            'content-type': 'application/json',
            cookie,
            'x-csrf-token': csrf,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        })
        return { status: r.status, body: (await r.json()) as Record<string, unknown> }
      }
    }
    return { db, as }
  }

  test('brief IDs run per author and are never reused', async () => {
    const { as } = await setup()
    const alex = await as('alex')
    await alex('POST', '/api/projects', { name: 'One' })
    await alex('POST', '/api/projects', { name: 'Two' })
    expect(((await alex('GET', '/api/p/one/brief')).body.brief as { id: string }).id).toBe('alex1')
    expect(((await alex('GET', '/api/p/two/brief')).body.brief as { id: string }).id).toBe('alex2')
    // Asking again doesn't use up a number.
    expect(((await alex('GET', '/api/p/one/brief')).body.brief as { id: string }).id).toBe('alex1')
  })

  test('editing a block records the person as its source and keeps it in their draft', async () => {
    const { as } = await setup()
    const alex = await as('alex')
    await alex('POST', '/api/projects', { name: 'Go' })
    const r = await alex('PUT', '/api/p/go/brief/blocks/audience', { text: 'CIOs' })
    expect(r.status).toBe(200)
    const block = (r.body.brief as { blocks: { key: string }[] }).blocks.find(
      (x) => x.key === 'audience',
    )
    expect(block).toMatchObject({
      state: 'filled',
      text: 'CIOs',
      source: { kind: 'user', by: 'alex' },
    })
    expect(r.body.openQuestions).not.toContain('audience')
    expect((await alex('PUT', '/api/p/go/brief/blocks/nonsense', { text: 'x' })).status).toBe(400)
  })

  test('approval follows the install setting, and open questions never block it', async () => {
    const { as, db } = await setup()
    const alex = await as('alex')
    await alex('POST', '/api/projects', { name: 'Go' })
    db.query("update settings set value = 'required' where key = 'brief_approval'").run()
    const r = await alex('POST', '/api/p/go/brief/approve')
    expect(r).toMatchObject({ status: 200, body: { brief: { status: 'approved' } } })
    expect((r.body.openQuestions as string[]).length).toBe(10)
    // Who approved, and when, is recorded (decision #43).
    expect(r.body.lastApproval).toMatchObject({ by: 'alex', at: expect.any(String) })
  })

  test('the change log is derived from the draft versions', async () => {
    const { as } = await setup()
    const alex = await as('alex')
    await alex('POST', '/api/projects', { name: 'Go' })
    await alex('PUT', '/api/p/go/brief/blocks/audience', { text: 'CIOs' })
    await alex('PUT', '/api/p/go/brief/blocks/audience', { text: 'CIOs and architects' })
    await alex('POST', '/api/p/go/brief/blocks/audience/clear')
    const log = (await alex('GET', '/api/p/go/brief')).body.changeLog as {
      key: string
      change: string
    }[]
    expect(log.map((e) => `${e.key}:${e.change}`)).toEqual([
      'audience:filled',
      'audience:edited',
      'audience:cleared',
    ])
  })
})
