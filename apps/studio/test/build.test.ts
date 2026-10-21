// M6.1: build once into one package (plan §9, §9.1; docs/m6-interfaces.md): composed pages,
// minified, hashed CSS names, sitemap and robots, one deterministic archive, one hash.
import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedTestAccounts } from '../server/auth/seed.ts'
import { brandDir } from '../server/brand/guide.ts'
import { BuildError } from '../server/build/index.ts'
import { openDb } from '../server/db/index.ts'
import { createPreview } from '../server/preview/index.ts'
import { signReviewLink } from '../server/preview/review-link.ts'
import { buildPackage, packageHash } from '../server/review/package.ts'
import { getBlob, putBlob } from '../server/store/blobs.ts'
import { createProject, projectDir, saveRevision } from '../server/store/revisions.ts'
import { addPage, addToMenu, emptyStructure } from '../server/structure/structure.ts'

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

const enc = new TextEncoder()
const dec = new TextDecoder()
const CSS =
  'body {\n  font-family: "PT Sans", sans-serif;\n  color: #2e4163;\n  background: #ffffff;\n}\n'
const page = (inner: string) =>
  `<!doctype html>\n<html>\n<head>\n  <!-- a comment -->\n  <link rel="stylesheet" href="style.css">\n</head>\n<body>\n${inner}\n</body>\n</html>\n`
const sec = (id: string, inner: string) => `<section data-section="${id}">${inner}</section>`
const HOME = page(sec('s-aaaaaa', '<h2>Hello</h2>'))
const TEAM = page(sec('s-cccccc', '<h2>Team</h2>'))
const HEADER = '<header><a href="index.html">Logo</a><nav>placeholder</nav></header>'
const FOOTER = '<footer><p>Footer text</p></footer>'

type Opts = { partials?: boolean; teamHtml?: string; address?: string }

async function setup(o: Opts = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'studio-build-'))
  dirs.push(dataDir)
  const db = openDb(':memory:')
  seedTestAccounts(db)
  const ctx = { db, dataDir, instanceId: 'qw' }
  createProject(ctx, { name: 'Go', by: 'alex' })
  const dir = projectDir(dataDir, 'go')

  let s = emptyStructure(o.address ?? 'example.com')
  const about = addPage(s, { title: 'About', slug: 'about', type: 'core' })
  s = about.structure
  const team = addPage(s, { title: 'Team', slug: 'team', parent: about.id, type: 'core' })
  s = team.structure
  const root = s.roots[0]?.address as string
  s = addToMenu(s, root, 'main', { page: 'home', label: 'Home' })
  s = addToMenu(s, root, 'main', { page: about.id, label: 'About' })
  s = addToMenu(s, root, 'main', { page: team.id, label: 'Team' }, about.id)

  const board = async (id: number, pageId: string, html: string) => ({
    id,
    page: pageId,
    letter: 'A',
    role: 'lead',
    html: await putBlob(dir, enc.encode(html)),
    css: await putBlob(dir, enc.encode(CSS)),
    sections: [],
  })
  const design = {
    artboards: [await board(1, 'home', HOME), await board(2, team.id, o.teamHtml ?? TEAM)],
  }
  if (o.partials) {
    const user = db.query('select id from users where handle = ?').get('alex') as { id: number }
    for (const [name, html] of [
      ['header', HEADER],
      ['footer', FOOTER],
    ] as const) {
      const hash = await putBlob(brandDir(dataDir), enc.encode(html))
      db.query(
        'insert into brand_partials (name, n, hash, by_user, at) values (?, 1, ?, ?, ?)',
      ).run(name, hash, user.id, new Date().toISOString())
    }
  }
  const rev = await saveRevision(ctx, {
    project: 'go',
    parent: null,
    by: 'alex',
    phase: 'design',
    files: {
      'structure.json': await putBlob(dir, enc.encode(JSON.stringify(s))),
      'design.json': await putBlob(dir, enc.encode(JSON.stringify(design))),
    },
  })
  return { ctx, dataDir, dir, rev, teamId: team.id, aboutId: about.id }
}

/** A tiny ustar reader: name, size and the bytes of every entry, plus the header fields we fix. */
function untar(t: Uint8Array) {
  const out: { path: string; bytes: Uint8Array; mtime: string; mode: string; owner: string }[] = []
  const text = (a: number, b: number, h: Uint8Array) =>
    dec.decode(h.subarray(a, b)).replace(/\0.*$/s, '')
  for (let at = 0; ; ) {
    const h = t.subarray(at, at + 512)
    if (h.every((b) => b === 0)) break
    const size = Number.parseInt(text(124, 136, h), 8)
    out.push({
      path: text(0, 100, h),
      bytes: t.subarray(at + 512, at + 512 + size),
      mtime: text(136, 148, h),
      mode: text(100, 108, h),
      owner: [text(108, 116, h), text(116, 124, h), text(265, 297, h), text(297, 329, h)].join('|'),
    })
    at += 512 + Math.ceil(size / 512) * 512
  }
  return out
}

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

describe('the build', () => {
  setDefaultTimeout(30_000)
  test('the same revision gives a byte-identical archive and hash in fresh dirs', async () => {
    const a = await setup({ partials: true })
    const b = await setup({ partials: true })
    const pa = await buildPackage(a.ctx, 'go', a.rev)
    const pb = await buildPackage(b.ctx, 'go', b.rev)
    expect(pa.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(pa.hash).toBe(pb.hash)
    const ba = await getBlob(a.dir, pa.archive)
    const bb = await getBlob(b.dir, pb.archive)
    expect(Buffer.from(ba).equals(Buffer.from(bb))).toBe(true)
    expect(pa.archive).toBe(`sha256:${pa.hash}`)
    expect(sha(ba)).toBe(pa.hash)
    expect(await packageHash(a.dir, pa)).toBe(pa.hash)
  })

  test('the index is written once, with the archive; every file equals its archive entry', async () => {
    const t = await setup({ partials: true })
    const pkg = await buildPackage(t.ctx, 'go', t.rev)
    const onDisk = JSON.parse(readFileSync(join(t.dir, 'packages', `${t.rev}.json`), 'utf8'))
    expect(onDisk).toEqual(pkg)
    expect(Object.keys(onDisk).sort()).toEqual(['archive', 'files', 'hash', 'rev'])
    const entries = untar(await getBlob(t.dir, pkg.archive))
    expect(entries.map((e) => e.path)).toEqual(Object.keys(pkg.files)) // sorted, same set
    expect(entries.map((e) => e.path)).toEqual([...entries.map((e) => e.path)].sort())
    for (const e of entries) {
      const stored = await getBlob(t.dir, pkg.files[e.path] as string)
      expect(Buffer.from(stored).equals(Buffer.from(e.bytes))).toBe(true)
      expect(e.mtime).toMatch(/^0+$/)
      expect(e.mode).toMatch(/0644/)
      expect(e.owner).toBe('0000000|0000000||')
    }
  })

  test('links are relative and the hashed CSS name is referenced', async () => {
    const t = await setup({ partials: true })
    const pkg = await buildPackage(t.ctx, 'go', t.rev)
    const files = Object.keys(pkg.files)
    const css = files.filter((p) => p.endsWith('.css'))
    expect(css).toEqual([
      expect.stringMatching(/^about\/team\/style\.[0-9a-f]{8}\.css$/),
      expect.stringMatching(/^style\.[0-9a-f]{8}\.css$/),
    ])
    const get = async (p: string) => dec.decode(await getBlob(t.dir, pkg.files[p] as string))
    const home = await get('index.html')
    const team = await get('about/team/index.html')
    expect(home).toContain(`href="${(css[1] as string).split('/').pop()}"`)
    expect(home).not.toContain('href="style.css"')
    expect(team).toContain(`href="${(css[0] as string).split('/').pop()}"`)
    // the hash in the name is the first 8 hex of the CSS file's SHA-256
    for (const p of css)
      expect(p.split('.').at(-2)).toBe(
        sha(await getBlob(t.dir, pkg.files[p] as string)).slice(0, 8),
      )
    // minified: no comment, section ids and the stylesheet link kept
    expect(home).not.toContain('a comment')
    expect(home).toContain('data-section="s-aaaaaa"')
    expect((await get(css[1] as string)).trim().split('\n')).toHaveLength(1)
    expect(home).not.toMatch(/(?:href|src)="\//)
    expect(team).not.toMatch(/(?:href|src)="\//)
  })

  test('partials and the main menu appear, with links relative to each page', async () => {
    const t = await setup({ partials: true })
    const pkg = await buildPackage(t.ctx, 'go', t.rev)
    const get = async (p: string) => dec.decode(await getBlob(t.dir, pkg.files[p] as string))
    const home = await get('index.html')
    const team = await get('about/team/index.html')
    // header right after <body>, footer right before </body>
    expect(home).toMatch(/<body[^>]*><header>/)
    expect(home).toMatch(/<\/footer><\/body>/)
    expect(home).toContain('Footer text')
    expect(home).not.toContain('placeholder')
    // About has no Lead, so it has no page and no link; Team (a child of About) is still linked
    expect(home).toContain('<a href="index.html">Home</a>')
    expect(home).toContain('<a href="about/team/index.html">Team</a>')
    expect(home).not.toContain('>About</a>')
    expect(team).toContain('<a href="../../index.html">Home</a>')
    expect(team).toContain('<a href="index.html">Team</a>')
    expect(home).toContain('<nav><ul>')
  })

  test('without partials nothing is inserted', async () => {
    const t = await setup()
    const pkg = await buildPackage(t.ctx, 'go', t.rev)
    const home = dec.decode(await getBlob(t.dir, pkg.files['index.html'] as string))
    expect(home).not.toContain('<header')
    expect(home).not.toContain('<footer')
    expect(home).not.toContain('<nav')
  })

  test('sitemap.xml and robots.txt are present, with the project address', async () => {
    const t = await setup()
    const pkg = await buildPackage(t.ctx, 'go', t.rev)
    const get = async (p: string) => dec.decode(await getBlob(t.dir, pkg.files[p] as string))
    const sitemap = await get('sitemap.xml')
    expect(sitemap).toContain('<loc>https://example.com/</loc>')
    expect(sitemap).toContain('<loc>https://example.com/about/team/</loc>')
    const robots = await get('robots.txt')
    expect(robots).toContain('Sitemap: https://example.com/sitemap.xml')
  })

  test('a floor error in a composed page fails the build with a code, and stores nothing', async () => {
    const t = await setup({
      teamHtml: page(sec('s-cccccc', '<h2>Team</h2><script>alert(1)</script>')),
    })
    const err = await buildPackage(t.ctx, 'go', t.rev).catch((e) => e)
    expect(err).toBeInstanceOf(BuildError)
    expect(err.code).toBe('build-floor-error')
    expect(err.issues[0].page).toBe(t.teamId)
    expect(() => readFileSync(join(t.dir, 'packages', `${t.rev}.json`))).toThrow()
  })

  test('the preview serves the built bytes', async () => {
    const t = await setup({ partials: true })
    const pkg = await buildPackage(t.ctx, 'go', t.rev)
    const secret = 'x'.repeat(40)
    const preview = createPreview({
      appUrl: new URL('http://localhost:3000'),
      appSecret: secret,
      dataDir: t.dataDir,
    })
    const base = signReviewLink(secret, { project: 'go', rev: t.rev, hash: pkg.hash })
    const files = base.replace('/__review/', '/r/')
    const entries = untar(await getBlob(t.dir, pkg.archive))
    for (const e of entries) {
      const r = await preview.request(`${files}${e.path}`)
      expect(r.status).toBe(200)
      expect(Buffer.from(await r.arrayBuffer()).equals(Buffer.from(e.bytes))).toBe(true)
    }
    expect((await preview.request(`${files}`)).status).toBe(200)
  })
})
