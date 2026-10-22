// Commands through the inbox: freeze and unfreeze (#1, #33), activate (#35), key changes
// (#25, #28, #32). Every refusal lands in the outbox with its code.
import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'
import { admin, release } from '../../../packages/shared/test/release-helpers.ts'
import { bundleOf, type Harness, harness, site } from './helpers.ts'

let h: Harness
afterEach(async () => {
  await h?.cleanup()
})

const body = async (path: string) => await (await h.get(path)).text()

describe('freeze', () => {
  test('freeze works on the app signature alone; unfreeze without a passkey is refused', async () => {
    h = await harness()
    expect(await h.sendAppCommand({ command: 'freeze' })).toMatchObject({ ok: true, frozen: true })
    expect(h.agent.snapshot().trust.frozen).toBe(true)
    // The app's key can't unfreeze: that needs an Admin's passkey.
    expect(await h.sendAppCommand({ command: 'unfreeze' })).toMatchObject({
      ok: false,
      code: 'passkey-required',
    })
    expect(h.agent.snapshot().trust.frozen).toBe(true)
    expect(await h.sendCommand({ command: 'unfreeze' })).toMatchObject({ ok: true, frozen: false })
  })

  test('a forged app signature is refused', async () => {
    h = await harness()
    const sequence = ++h.sequence
    const signed = await h.app.sign({ sequence, command: 'freeze' })
    const forged = { ...signed, signatures: [{ by: 'app', value: 'A'.repeat(86) }] }
    h.put(`cmd-${sequence}.json`, JSON.stringify(forged))
    await h.scan()
    expect(h.result(`cmd-${sequence}.json`)).toMatchObject({
      ok: false,
      code: 'bad-app-signature',
    })
    expect(h.agent.snapshot().trust.frozen).toBe(false)
  })

  test('while frozen a release and activate are refused, but key changes work', async () => {
    h = await harness()
    expect((await h.sendRelease(1, await bundleOf(site('one')))).ok).toBe(true)
    expect((await h.sendRelease(2, await bundleOf(site('two')))).ok).toBe(true)
    expect((await h.sendAppCommand({ command: 'freeze' })).ok).toBe(true)

    expect(await h.sendRelease(3, await bundleOf(site('three')))).toMatchObject({
      ok: false,
      code: 'frozen',
    })
    expect(await h.sendCommand({ command: 'activate', args: { release: 1 } })).toMatchObject({
      ok: false,
      code: 'frozen',
    })
    // The site keeps being served while frozen: freeze stops changes, not visitors (#33).
    expect(await body('/')).toContain('Home two')

    // A stolen key can still be removed, and an Admin can add a key of their own (#28, #33).
    const alexPhone = await admin('alex')
    expect(
      await h.sendCommand({ command: 'trust-keys', args: { add: [alexPhone.key] } }, [h.alex]),
    ).toMatchObject({ ok: true })
    expect(
      await h.sendCommand({ command: 'remove-key', args: { remove: [h.sam.key.keyId] } }),
    ).toMatchObject({ ok: true })
    const keys = h.agent.snapshot().trust.keys.map((k: { keyId: string }) => k.keyId)
    expect(keys).toContain(alexPhone.key.keyId)
    expect(keys).not.toContain(h.sam.key.keyId)

    expect((await h.sendCommand({ command: 'unfreeze' })).ok).toBe(true)
    expect((await h.sendRelease(3, await bundleOf(site('three')))).ok).toBe(true)
  })

  test('a freeze that arrives with a release is handled first', async () => {
    h = await harness()
    const bundle = await bundleOf(site('one'))
    h.put('release-1.tar', bundle)
    h.put('release-1.json', JSON.stringify(await release(bundle, 1, [h.alex])))
    const sequence = ++h.sequence
    h.put(`cmd-${sequence}.json`, JSON.stringify(await h.app.sign({ sequence, command: 'freeze' })))
    await h.scan()
    expect(h.result(`cmd-${sequence}.json`).ok).toBe(true)
    expect(h.result('release-1.json')).toMatchObject({ ok: false, code: 'frozen' })
  })
})

describe('activate', () => {
  test('activate goes to a kept release, and refuses one that is not kept', async () => {
    h = await harness({ keep: 3 })
    for (const n of [1, 2, 3, 4]) {
      expect((await h.sendRelease(n, await bundleOf(site(`r${n}`)))).ok).toBe(true)
    }
    expect(await body('/')).toContain('Home r4')
    // Keep is 3: release 1 has been removed from disk and from what activate may choose.
    expect(h.agent.snapshot().kept).toEqual([2, 3, 4])
    expect(Object.keys(h.agent.snapshot().trust.releases).sort()).toEqual(['2', '3', '4'])

    const r = await h.sendCommand({ command: 'activate', args: { release: 2 } })
    expect(r).toMatchObject({ ok: true, release: 2, smoke: { outcome: 'passed' } })
    expect(await body('/')).toContain('Home r2')
    expect(readlinkSync(join(h.root, 'agent', 'current')).replaceAll('\\', '/')).toEndWith(
      'releases/2',
    )
    expect(h.agent.snapshot()).toMatchObject({ active: 2, previous: 4 })
    // Release numbers keep moving forward: activate never lowers what a release must exceed.
    expect(h.agent.snapshot().trust.highestRelease).toBe(4)

    expect(await h.sendCommand({ command: 'activate', args: { release: 1 } })).toMatchObject({
      ok: false,
      code: 'unknown-release',
    })
    expect(await h.sendCommand({ command: 'activate', args: { release: 99 } })).toMatchObject({
      ok: false,
      code: 'unknown-release',
    })
    // The app alone can't roll back.
    expect(await h.sendAppCommand({ command: 'activate', args: { release: 3 } })).toMatchObject({
      ok: false,
      code: 'passkey-required',
    })
    // Forward again to the newest.
    expect((await h.sendCommand({ command: 'activate', args: { release: 4 } })).ok).toBe(true)
    expect(await body('/')).toContain('Home r4')
  })

  test('a replayed command is refused', async () => {
    h = await harness()
    expect((await h.sendRelease(1, await bundleOf(site('one')))).ok).toBe(true)
    expect((await h.sendRelease(2, await bundleOf(site('two')))).ok).toBe(true)
    const r = await h.sendCommand({ command: 'activate', args: { release: 1 } })
    expect(r.ok).toBe(true)
    // The same signed file uploaded again under a new name.
    const name = `cmd-${h.sequence}.json`
    const text = readFileSync(join(h.inbox, name), 'utf8')
    h.put('again.json', text)
    await h.scan()
    expect(h.result('again.json')).toMatchObject({ ok: false, code: 'replayed' })
  })
})

describe('keys', () => {
  test('removed keys stay removed, and a removed key signs nothing', async () => {
    h = await harness()
    expect(
      await h.sendCommand({ command: 'remove-key', args: { remove: [h.sam.key.keyId] } }),
    ).toMatchObject({ ok: true })
    expect(
      await h.sendCommand({ command: 'trust-keys', args: { add: [h.sam.key] } }, [h.alex]),
    ).toMatchObject({ ok: false, code: 'revoked-key' })
    expect(await h.sendRelease(1, await bundleOf(site('one')), [h.sam])).toMatchObject({
      ok: false,
      code: 'unknown-key',
    })
    expect(await h.sendCommand({ command: 'remove-key', args: {} })).toMatchObject({
      ok: false,
      code: 'malformed',
    })
  })

  test('under a two-Admin rule one signature is not enough for a release', async () => {
    h = await harness({}, { pair: false })
    expect((await h.pair({ releases: 2 })).accepted.ok).toBe(true)
    const bundle = await bundleOf(site('one'))
    expect(await h.sendRelease(1, bundle, [h.alex])).toMatchObject({
      ok: false,
      code: 'not-enough-signers',
    })
    expect((await h.sendRelease(1, bundle, [h.alex, h.sam])).ok).toBe(true)
  })

  test('a genesis file after pairing is refused', async () => {
    h = await harness()
    const again = await h.pair()
    expect(again.accepted).toMatchObject({ ok: false, code: 'already-paired' })
  })
})
