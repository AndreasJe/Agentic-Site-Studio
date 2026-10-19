// Third security review (decisions #27–#35 batch): each defect has a test that fails without the fix.
import { describe, expect, test } from 'bun:test'
import { type Bytes, concat, utf8 } from '../src/bytes.ts'
import { listEntries, readManifest, SITE, writeBundle } from '../src/release/bundle.ts'
import {
  acceptCommand,
  acceptRelease,
  CLOCK_SKEW_MS,
  emptyState,
  genesisFingerprint,
  MAX_RELEASE_VALIDITY_MS,
} from '../src/release/trust.ts'
import {
  AT,
  admin,
  appKey,
  bundle,
  command,
  MANIFEST_DEFAULT,
  makeBundle,
  NOW,
  ok,
  paired,
  pairingFor,
  release,
} from './release-helpers.ts'

const BLOCK = 512

/** Rewrites one header field in place and fixes the checksum, keeping it a "valid" tar. */
function patch(t: Bytes, headerAt: number, offset: number, bytes: number[] | Uint8Array): Bytes {
  const out = t.slice()
  out.set(bytes, headerAt + offset)
  for (let i = 148; i < 156; i++) out[headerAt + i] = 0x20
  let sum = 0
  for (let i = 0; i < BLOCK; i++) sum += out[headerAt + i] ?? 0
  out.set(utf8.encode(`${sum.toString(8).padStart(6, '0')}\0 `), headerAt + 148)
  return out
}

const secondHeader = () =>
  BLOCK + Math.ceil(utf8.encode(JSON.stringify(MANIFEST_DEFAULT)).length / BLOCK) * BLOCK

async function refusedThroughProduction(hostile: Bytes) {
  const a = await admin('alex')
  const { state } = await paired([a])
  return acceptRelease(state, await release(hostile, 1, [a]), hostile, AT)
}

describe('production checks the whole archive, not only the manifest', () => {
  test('a path that climbs out is refused', async () => {
    const name = new Uint8Array(100)
    name.set(utf8.encode('../index.html'))
    const hostile = patch(bundle, secondHeader(), 0, name)
    expect(() => listEntries(hostile)).toThrow('unsafe path')
    expect(await refusedThroughProduction(hostile)).toMatchObject({ ok: false, code: 'malformed' })
  })

  test('a second manifest is refused', async () => {
    const name = new Uint8Array(100)
    name.set(utf8.encode('release-manifest.json'))
    const hostile = patch(bundle, secondHeader(), 0, name)
    expect(() => listEntries(hostile)).toThrow('duplicate')
    expect(await refusedThroughProduction(hostile)).toMatchObject({ ok: false, code: 'malformed' })
  })

  test('entries hidden after a single zero block, or trailing bytes, are refused', async () => {
    const end = bundle.length - 2 * BLOCK
    const hidden = concat(
      bundle.subarray(0, end),
      new Uint8Array(BLOCK),
      bundle.subarray(BLOCK, end),
      new Uint8Array(2 * BLOCK),
    )
    expect(() => listEntries(hidden)).toThrow('two zero blocks')
    expect(await refusedThroughProduction(hidden)).toMatchObject({ ok: false, code: 'malformed' })
    const trailing = concat(bundle, utf8.encode('x'))
    expect(await refusedThroughProduction(trailing)).toMatchObject({ ok: false, code: 'malformed' })
  })

  test('a header with another mode, an owner, a link name or junk after the name is refused', async () => {
    const h = secondHeader()
    const variants = [
      patch(bundle, h, 100, utf8.encode('0004755\0')), // setuid
      patch(bundle, h, 108, utf8.encode('0001750\0')), // uid
      patch(bundle, h, 157, utf8.encode('/etc/passwd')), // linkname
      patch(bundle, h, 11, utf8.encode('\0junk')), // after "index.html\0"
      patch(bundle, 0, 136, utf8.encode('14724351520\0')), // manifest mtime
    ]
    for (const v of variants) {
      expect(() => listEntries(v)).toThrow('not canonical')
      expect(await refusedThroughProduction(v)).toMatchObject({ ok: false, code: 'malformed' })
    }
  })

  test('a typeflag of NUL is refused like any non-file entry', () => {
    expect(() => listEntries(patch(bundle, secondHeader(), 156, [0]))).toThrow('regular file')
  })
})

describe('site is a live address', () => {
  test('hostnames and hostname paths pass; anything else is refused', () => {
    for (const ok_ of [
      'example.com',
      'go.example.com',
      'example.com/campaigns/go-launch',
      'a-b.example.co.uk',
    ]) {
      expect(SITE.test(ok_)).toBe(true)
      expect(readManifest(makeBundle('x', { site: ok_ })).site).toBe(ok_)
    }
    for (const bad of [
      '../../var/www',
      'example',
      'Example.com',
      'example.com/../x',
      'localhost',
      'example.com/',
      '-a.com',
      'a.c',
    ]) {
      expect(SITE.test(bad)).toBe(false)
      expect(() => makeBundle('x', { site: bad })).toThrow('site')
    }
  })
})

describe('new Admins under the strictest rule', () => {
  test('with only the domains rule at two, one Admin still cannot add a new Admin', async () => {
    const a = await admin('alex')
    const b = await admin('bjarke')
    const { state } = await paired([a, b], { releases: 1, keys: 1, domains: 2 })
    const x = await admin('x')
    const one = await command({ command: 'trust-keys', sequence: 2, args: { add: [x.key] } }, [a])
    expect(await acceptCommand(state, one, { now: NOW })).toMatchObject({
      ok: false,
      code: 'not-enough-signers',
    })
    ok(
      await acceptCommand(
        state,
        await command({ command: 'trust-keys', sequence: 2, args: { add: [x.key] } }, [a, b]),
        { now: NOW },
      ),
    )
  })
})

describe('the release lifetime boundary', () => {
  test('7 days plus clock skew is the last accepted moment', async () => {
    const a = await admin('alex')
    const { state } = await paired([a])
    const edge = NOW.getTime() + MAX_RELEASE_VALIDITY_MS + CLOCK_SKEW_MS
    const over = makeBundle('over', { validUntil: new Date(edge + 1).toISOString() })
    expect(await acceptRelease(state, await release(over, 1, [a]), over, AT)).toMatchObject({
      ok: false,
      code: 'too-long-lived',
    })
    const atEdge = makeBundle('edge', { validUntil: new Date(edge).toISOString() })
    ok(await acceptRelease(state, await release(atEdge, 1, [a]), atEdge, AT))
  })
})

describe('small hardening from review 3', () => {
  test('paths that differ only by case are refused, when writing and when reading', () => {
    const files = [
      { path: 'index.html', bytes: utf8.encode('a') },
      { path: 'Index.html', bytes: utf8.encode('b') },
    ]
    expect(() => makeBundle('x', {})).not.toThrow()
    expect(() =>
      writeBundle(MANIFEST_DEFAULT, files as { path: string; bytes: Uint8Array }[]),
    ).toThrow('duplicate')
    const forced = writeBundle(MANIFEST_DEFAULT, files as { path: string; bytes: Uint8Array }[], {
      allowDuplicates: true,
    })
    expect(() => listEntries(forced)).toThrow('duplicate')
  })

  test('the pairing origin must be https, except localhost for development', async () => {
    const a = await admin('alex')
    const app = await appKey()
    for (const [appOrigin, accepted] of [
      ['http://studio.internal', false],
      ['https://studio.internal', true],
      ['http://localhost:3000', true],
      ['ftp://studio.internal', false],
    ] as const) {
      const g = await command(
        {
          command: 'trust-keys',
          sequence: 1,
          args: {
            genesis: true,
            add: [a.key],
            pairing: { ...pairingFor(app.publicKey), appOrigin },
          },
        },
        [a],
      )
      const r = await acceptCommand(emptyState(), g, {
        now: NOW,
        confirmedFingerprint: await genesisFingerprint(g),
      })
      // An accepted https origin still fails the signature check here (it was signed on
      // localhost), which proves parsing got past the origin rule.
      expect(r.ok ? 'ok' : r.code).toBe(
        accepted ? (appOrigin.startsWith('https') ? 'origin-mismatch' : 'ok') : 'malformed',
      )
    }
  })
})
