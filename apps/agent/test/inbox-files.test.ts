// M7 security review, finding 7: the agent reads its inbox without following links, and only
// regular files, capped at the size fstat gave. A symlink can only be made with privileges on
// Windows; there that part is skipped, the non-regular-file refusal is tested everywhere.
import 'reflect-metadata'
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { release } from '../../../packages/shared/test/release-helpers.ts'
import { readInboxFile } from '../src/fsx.ts'
import { bundleOf, type Harness, harness, site } from './helpers.ts'

let h: Harness | undefined
afterEach(async () => {
  await h?.cleanup()
  h = undefined
})

/** A symlink, or null where the platform won't make one for this user. */
function trySymlink(target: string, path: string): boolean {
  try {
    symlinkSync(target, path, 'file')
    return true
  } catch {
    return false
  }
}

describe('inbox files', () => {
  test('a bundle that is not a regular file is refused, and the agent carries on', async () => {
    h = await harness()
    const bundle = await bundleOf(site('one'))
    mkdirSync(join(h.inbox, 'release-1.tar'))
    h.put('release-1.json', JSON.stringify(await release(bundle, 1, [h.alex])))
    await h.scan()
    expect(h.result('release-1.json')).toMatchObject({ ok: false, code: 'unknown-file' })
    expect(h.agent.snapshot().active).toBe(0)
    // A real bundle under the next number still goes live.
    expect((await h.sendRelease(2, bundle)).ok).toBe(true)
  })

  test('readInboxFile refuses a directory, a missing file and one over the cap', () => {
    const root = mkdtempSync(join(tmpdir(), 'inbox-read-'))
    mkdirSync(join(root, 'd'))
    writeFileSync(join(root, 'f.json'), '{"a":1}')
    expect(readInboxFile(join(root, 'd'), 100)).toMatchObject({ ok: false, code: 'not-a-file' })
    expect(readInboxFile(join(root, 'none.json'), 100)).toMatchObject({
      ok: false,
      code: 'not-a-file',
    })
    expect(readInboxFile(join(root, 'f.json'), 3)).toMatchObject({ ok: false, code: 'too-large' })
    const ok = readInboxFile(join(root, 'f.json'), 100)
    expect(ok.ok && new TextDecoder().decode(ok.bytes)).toBe('{"a":1}')
    rmSync(root, { recursive: true, force: true })
  })

  test('a symlink in the inbox is never followed (skipped where links need privileges)', async () => {
    h = await harness()
    const outside = join(h.root, 'outside')
    mkdirSync(outside)
    // A freeze command and a bundle that live outside the inbox, linked in.
    const sequence = ++h.sequence
    const freeze = await h.app.sign({ command: 'freeze', sequence })
    writeFileSync(join(outside, 'cmd.json'), JSON.stringify(freeze))
    const bundle = await bundleOf(site('one'))
    writeFileSync(join(outside, 'bundle.tar'), bundle)
    if (!trySymlink(join(outside, 'cmd.json'), join(h.inbox, `cmd-${sequence}.json`))) {
      console.warn('symlinks need privileges here: link part skipped')
      return
    }
    expect(trySymlink(join(outside, 'bundle.tar'), join(h.inbox, 'release-1.tar'))).toBe(true)
    h.put('release-1.json', JSON.stringify(await release(bundle, 1, [h.alex])))
    await h.scan()
    // The linked command was not read: no result, not frozen.
    expect(existsSync(join(h.outbox, 'results', `cmd-${sequence}.json`))).toBe(false)
    expect(h.agent.snapshot().trust.frozen).toBe(false)
    // The linked bundle is refused.
    expect(h.result('release-1.json')).toMatchObject({ ok: false, code: 'unknown-file' })
    expect(readInboxFile(join(h.inbox, `cmd-${sequence}.json`), 1 << 20)).toMatchObject({
      ok: false,
      code: 'not-a-file',
    })
  })
})
