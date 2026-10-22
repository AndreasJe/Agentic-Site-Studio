// Releases through the inbox: what production accepts, what it refuses, and what it serves.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'
import { utf8 } from '@site-studio/shared/bytes'
import { writeArchive, writeBundle } from '@site-studio/shared/release'
import { admin, release } from '../../../packages/shared/test/release-helpers.ts'
import { siteCsp } from '../src/server.ts'
import { bundleOf, type File, type Harness, harness, MANIFEST, NOW, page, site } from './helpers.ts'

let h: Harness
afterEach(async () => {
  await h?.cleanup()
})

describe('an accepted release', () => {
  test('pairing waits for the fingerprint, then the release switches current and serves the bytes', async () => {
    h = await harness({}, { pair: false })
    const p = await h.pair()
    expect(p.waiting).toMatchObject({ ok: false, code: 'fingerprint-not-confirmed' })
    expect(p.waiting.detail).toBe(p.fingerprint)
    expect(p.accepted).toMatchObject({ ok: true, command: 'trust-keys' })

    const files = site('one')
    const [index, about] = files as [File, File, File]
    const r = await h.sendRelease(1, await bundleOf(files))
    expect(r).toMatchObject({
      ok: true,
      release: 1,
      revision: 'qualiwarego-r7',
      site: 'example.com',
    })
    expect((r.smoke as { outcome: string }).outcome).toBe('passed')

    const link = join(h.root, 'agent', 'current')
    expect(readlinkSync(link).replaceAll('\\', '/')).toEndWith('releases/1')
    expect(readFileSync(join(link, 'index.html'))).toEqual(Buffer.from(index.bytes))

    const home = await h.get('/')
    expect(home.status).toBe(200)
    expect(new Uint8Array(await home.arrayBuffer())).toEqual(index.bytes)
    expect(home.headers.get('content-security-policy')).toBe(siteCsp(null))
    expect(home.headers.get('content-security-policy')).toContain("frame-src 'none'")
    expect(home.headers.get('content-security-policy')).toEndWith("frame-ancestors 'none'")
    expect(home.headers.get('x-content-type-options')).toBe('nosniff')
    expect(home.headers.get('set-cookie')).toBeNull()
    const aboutPage = await h.get('/about/')
    expect(new Uint8Array(await aboutPage.arrayBuffer())).toEqual(about.bytes)
    expect((await h.get('/about', { redirect: 'manual' })).status).toBe(301)
    expect((await h.get('/../state/state.json')).status).toBe(404)
    expect((await h.get('/%2e%2e/state/state.json')).status).toBe(404)
    expect((await h.get('/', { method: 'POST' })).status).toBe(405)

    expect(h.agent.snapshot()).toMatchObject({ active: 1, kept: [1] })
    expect(h.agent.snapshot().trust.highestRelease).toBe(1)
    const smoke = h.out('smoke/1.json')
    expect(smoke).toMatchObject({ release: 1, passed: true, outcome: 'passed' })
  })

  test('the state survives a restart: the active release is served and old numbers stay used', async () => {
    h = await harness()
    const bundle = await bundleOf(site('one'))
    expect((await h.sendRelease(1, bundle)).ok).toBe(true)
    await h.restart()
    expect(h.agent.snapshot()).toMatchObject({ active: 1, kept: [1] })
    expect((await h.get('/')).status).toBe(200)
    // The same files uploaded again after the restart: still a replay.
    expect(await h.sendRelease(1, bundle)).toMatchObject({
      ok: false,
      code: 'release-number-not-higher',
    })
  })
})

describe('refused releases', () => {
  test('a replayed bundle is refused, and so is a lower release number', async () => {
    h = await harness()
    const one = await bundleOf(site('one'))
    expect((await h.sendRelease(3, one)).ok).toBe(true)
    // The same files again (a new upload of the same release-3 pair).
    expect(await h.sendRelease(3, one)).toMatchObject({
      ok: false,
      code: 'release-number-not-higher',
    })
    // A properly signed, newer package under a lower number.
    expect(await h.sendRelease(2, await bundleOf(site('two')))).toMatchObject({
      ok: false,
      code: 'release-number-not-higher',
    })
    expect(h.agent.snapshot()).toMatchObject({ active: 3, kept: [3] })
  })

  test('an unsigned or wrongly signed bundle is refused', async () => {
    h = await harness()
    const bundle = await bundleOf(site('one'))
    expect(await h.sendRelease(1, bundle, [])).toMatchObject({ ok: false, code: 'malformed' })
    const stranger = await admin('mallory')
    expect(await h.sendRelease(1, bundle, [stranger])).toMatchObject({
      ok: false,
      code: 'unknown-key',
    })
    // Alex's real signature, but over a different bundle: release.json names this bundle's hash.
    const other = await bundleOf(site('other'))
    h.put('release-1.tar', bundle)
    const signedOther = await release(other, 1, [h.alex])
    const sha = new Bun.CryptoHasher('sha256').update(bundle).digest('hex')
    h.put('release-1.json', JSON.stringify({ ...signedOther, packageHash: `sha256:${sha}` }))
    await h.scan()
    expect(h.result('release-1.json')).toMatchObject({ ok: false, code: 'challenge-mismatch' })
    expect(h.agent.snapshot().active).toBe(0)
    expect((await h.get('/')).status).toBe(503)
  })

  test('a release before pairing is refused', async () => {
    h = await harness({}, { pair: false })
    expect(await h.sendRelease(1, await bundleOf(site('one')))).toMatchObject({
      ok: false,
      code: 'no-trusted-keys',
    })
  })

  test('an expired manifest is refused, and so is one valid too long', async () => {
    h = await harness()
    const expired = await bundleOf(site('one'), {
      validUntil: new Date(NOW.getTime() - 60_000).toISOString(),
    })
    expect(await h.sendRelease(1, expired)).toMatchObject({ ok: false, code: 'expired' })
    const long = await bundleOf(site('one'), {
      validUntil: new Date(NOW.getTime() + 8 * 24 * 3600_000).toISOString(),
    })
    expect(await h.sendRelease(1, long)).toMatchObject({ ok: false, code: 'too-long-lived' })
    // Time passes on the server: a bundle valid when built expires before it is acted on.
    const later = await bundleOf(site('one'))
    h.clock.now = new Date(NOW.getTime() + 7 * 24 * 3600_000)
    expect(await h.sendRelease(1, later)).toMatchObject({ ok: false, code: 'expired' })
  })

  test('a wrong target, a wrong site and a release.json that disagrees are refused', async () => {
    h = await harness()
    expect(
      await h.sendRelease(1, await bundleOf(site('one'), { target: 'staging' })),
    ).toMatchObject({ ok: false, code: 'wrong-target' })
    expect(
      await h.sendRelease(1, await bundleOf(site('one'), { site: 'other.example.org' })),
    ).toMatchObject({ ok: false, code: 'wrong-site' })
    expect(
      await h.sendRelease(1, await bundleOf(site('one')), [h.alex], { revision: 'qualiwarego-r8' }),
    ).toMatchObject({ ok: false, code: 'manifest-mismatch' })
    expect(h.agent.snapshot().trust.highestRelease).toBe(0)
  })

  test('a tampered site.tar is refused', async () => {
    h = await harness()
    // Changed after signing: the bundle no longer has the signed hash.
    const signed = await bundleOf(site('one'))
    const json = await release(signed, 1, [h.alex])
    const tampered = signed.slice()
    const at = tampered.length - 1024 - 600 // inside site.tar's last file
    tampered[at] = (tampered[at] ?? 0) ^ 1
    h.put('release-1.tar', tampered)
    h.put('release-1.json', JSON.stringify(json))
    await h.scan()
    expect(h.result('release-1.json')).toMatchObject({ ok: false, code: 'hash-mismatch' })

    // Signed as built, but site.tar is not the package the manifest names.
    const siteTar = writeArchive(site('one'))
    const wrong = writeBundle({ ...MANIFEST, packageHash: `sha256:${'0'.repeat(64)}` }, [
      { path: 'site.tar', bytes: siteTar },
    ])
    expect(await h.sendRelease(1, wrong)).toMatchObject({
      ok: false,
      code: 'package-hash-mismatch',
    })

    // The old layout (site files straight after the manifest) is not a release bundle.
    const old = writeBundle(MANIFEST, [{ path: 'index.html', bytes: page('old') }])
    expect(await h.sendRelease(1, old)).toMatchObject({ ok: false, code: 'bad-bundle' })
    expect(h.agent.snapshot()).toMatchObject({ active: 0, kept: [] })
    expect(existsSync(join(h.root, 'agent', 'releases', '1'))).toBe(false)
  })

  test('a release.json whose number differs from its file name, or that is not JSON, is refused', async () => {
    h = await harness()
    const bundle = await bundleOf(site('one'))
    h.put('release-5.tar', bundle)
    h.put('release-5.json', JSON.stringify(await release(bundle, 6, [h.alex])))
    await h.scan()
    expect(h.result('release-5.json')).toMatchObject({ ok: false, code: 'malformed' })
    h.put('release-7.tar', bundle)
    h.put('release-7.json', '{not json')
    await h.scan()
    expect(h.result('release-7.json')).toMatchObject({ ok: false, code: 'malformed' })
    h.put('notes.txt', utf8.encode('hello'))
    await h.scan()
    expect(h.result('notes.txt.json')).toMatchObject({ ok: false, code: 'unknown-file' })
  })
})
