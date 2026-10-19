// The production process on its own: files in, ACCEPTED/REFUSED out, state persisted between runs.
// Signatures come from the software authenticator; the browser version is ceremony.e2e.ts.
import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Bytes, sha256, toBase64Url, utf8 } from '@site-studio/shared/bytes'
import { commandChallenge, packageHashOf, releaseChallenge } from '@site-studio/shared/release'
import { verifyRegistration } from '@site-studio/shared/webauthn'
import { SoftAuthenticator } from '../../../packages/shared/test/soft-authenticator.ts'

const APP = 'http://localhost:3000'
const dir = mkdtempSync(join(tmpdir(), 'spike1-production-'))
const state = join(dir, 'state')
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function production(...args: string[]) {
  const p = Bun.spawnSync([
    process.execPath,
    join(import.meta.dir, '../src/production.ts'),
    ...args,
  ])
  return { code: p.exitCode, out: p.stdout.toString().trim() }
}

const write = (name: string, data: string | Bytes) => {
  writeFileSync(join(dir, name), data)
  return join(dir, name)
}

async function sig(auth: SoftAuthenticator, keyId: string, challenge: Bytes) {
  const a = await auth.assert({ challenge, origin: APP, rpId: 'localhost' })
  return {
    adminKeyId: keyId,
    authenticatorData: toBase64Url(a.authenticatorData),
    clientDataJSON: toBase64Url(a.clientDataJSON),
    signature: toBase64Url(a.signature),
  }
}

test('pairing, a release and its refusals, each in a fresh process', async () => {
  const auth = await SoftAuthenticator.create()
  const c = crypto.getRandomValues(new Uint8Array(32))
  const reg = await verifyRegistration({
    ...(await auth.register({ challenge: c, origin: APP, rpId: 'localhost' })),
    expectedChallenge: c,
    expectedOrigin: APP,
    rpId: 'localhost',
  })
  if (!reg.ok) throw new Error(reg.code)
  const keyId = toBase64Url(reg.credential.id)
  const key = {
    keyId,
    adminId: 'alex',
    alg: reg.credential.alg,
    publicKey: toBase64Url(reg.credential.publicKey),
  }

  expect(
    production(
      'init',
      state,
      APP,
      'localhost',
      'production',
      toBase64Url(new Uint8Array(32).fill(9)),
    ).out,
  ).toBe('INITIALISED')

  const genesis = {
    command: 'trust-keys',
    target: 'production',
    sequence: 1,
    expires: new Date(Date.now() + 3_600_000).toISOString(),
    args: { genesis: true, add: [key] },
  }
  const signedGenesis = {
    ...genesis,
    signatures: [
      { by: 'admin-passkey', ...(await sig(auth, keyId, await commandChallenge(genesis))) },
    ],
  }
  const gFile = write('genesis.json', JSON.stringify(signedGenesis))
  const shown = production('command', state, gFile)
  expect(shown.code).toBe(1)
  const fingerprint = shown.out.match(/FINGERPRINT (\S+)/)?.[1] ?? ''
  expect(fingerprint).toMatch(/^SHA256:/)
  expect(production('command', state, gFile, '--confirm', 'SHA256:not-it').out).toStartWith(
    'REFUSED fingerprint-not-confirmed',
  )
  expect(production('command', state, gFile, '--confirm', fingerprint).out).toBe('ACCEPTED')

  const bundle = utf8.encode('<!doctype html><p>bundle</p>')
  const release = {
    project: 'qualiwarego',
    revision: 'qualiwarego-r7',
    releaseNumber: 1,
    packageHash: await packageHashOf(bundle),
    approvedBy: 'alex',
    checks: 'passed',
    signatures: [await sig(auth, keyId, releaseChallenge(await sha256(bundle), 1))],
  }
  const rFile = write('release-1.json', JSON.stringify(release))
  const bFile = write('bundle-1.bin', bundle)
  const tampered = bundle.slice()
  tampered[5] = (tampered[5] ?? 0) ^ 1
  const tFile = write('bundle-1-tampered.bin', tampered)

  expect(production('release', state, rFile, tFile).out).toStartWith('REFUSED hash-mismatch')
  expect(production('release', state, rFile, bFile).out).toBe('ACCEPTED')
  // The accepted number is on disk now, so the same bundle can't be accepted again.
  expect(production('release', state, rFile, bFile).out).toStartWith(
    'REFUSED release-number-not-higher',
  )
  expect(JSON.parse(readFileSync(join(state, 'state.json'), 'utf8')).highestRelease).toBe(1)
  // Replaying the genesis file after pairing is refused too.
  expect(production('command', state, gFile, '--confirm', fingerprint).out).toStartWith(
    'REFUSED replayed',
  )
})

test('init refuses to overwrite a paired state, and a second run waits for the first', () => {
  const key = toBase64Url(new Uint8Array(32).fill(9))
  expect(production('init', state, APP, 'localhost', 'production', key).out).toBe(
    'REFUSED already-initialised',
  )
  writeFileSync(join(state, 'state.lock'), '')
  try {
    expect(
      production('release', state, join(dir, 'release-1.json'), join(dir, 'bundle-1.bin')).out,
    ).toBe('BUSY')
  } finally {
    rmSync(join(state, 'state.lock'))
  }
  // The lock is released after a normal run.
  production('release', state, join(dir, 'release-1.json'), join(dir, 'bundle-1.bin'))
  expect(existsSync(join(state, 'state.lock'))).toBe(false)
})

test('a lock left by a run that died is taken over', () => {
  // A pid that isn't running: the run that held it was killed.
  writeFileSync(join(state, 'state.lock'), '2147483646')
  expect(
    production('release', state, join(dir, 'release-1.json'), join(dir, 'bundle-1.bin')).out,
  ).toStartWith('REFUSED release-number-not-higher')
  expect(existsSync(join(state, 'state.lock'))).toBe(false)
})

test('a malformed inbox file is refused and still releases the lock', () => {
  for (const content of ['null', '{not json', '"just a string"']) {
    const file = write('bad.json', content)
    const out = production('command', state, file).out
    expect(out).toMatch(/^(REFUSED|ERROR) /)
    expect(existsSync(join(state, 'state.lock'))).toBe(false)
  }
  // A missing state directory is an error, not "busy".
  expect(production('command', join(dir, 'nowhere'), join(dir, 'bad.json')).out).toStartWith(
    'ERROR',
  )
})

test('production and everything it imports use no network', () => {
  const root = join(import.meta.dir, '../../..')
  const files = [
    join(import.meta.dir, '../src/production.ts'),
    ...['release', 'webauthn'].flatMap((d) =>
      readdirSync(join(root, 'packages/shared/src', d)).map((f) =>
        join(root, 'packages/shared/src', d, f),
      ),
    ),
    join(root, 'packages/shared/src/bytes.ts'),
  ]
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    expect(text).not.toMatch(
      /from ['"](node:)?(net|http|https|http2|dgram|dns|tls|child_process)['"]/,
    )
    expect(text).not.toMatch(
      /\bfetch\(|XMLHttpRequest|WebSocket|Bun\.(serve|connect|listen|spawn)|\bimport\(|\brequire\(/,
    )
  }
  const imports = [...readFileSync(files[0] as string, 'utf8').matchAll(/from '([^']+)'/g)].map(
    (m) => m[1],
  )
  expect(imports.sort()).toEqual(['@site-studio/shared/release', 'node:fs', 'node:path'])
})
