// Spike 1 "production": a separate process that only reads files and keeps its trust state on
// disk. No network: it is run by hand (or by the agent in spike 2) on what lands in the inbox.
//
//   bun src/production.ts init     <state-dir>
//   bun src/production.ts command  <state-dir> <command.json> [--confirm <fingerprint>]
//   bun src/production.ts release  <state-dir> <release.json> <bundle-file>
//
// Prints ACCEPTED, REFUSED <code>, BUSY or ERROR <message>; exit code 0, 1, 3 or 2.
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  acceptCommand,
  acceptRelease,
  emptyState,
  genesisFingerprint,
  type TrustState,
} from '@site-studio/shared/release'

type Outcome = { line: string; code: number }

const statePath = (dir: string) => join(dir, 'state.json')
const errno = (err: unknown) => (err as { code?: string }).code

function load(dir: string): TrustState {
  return JSON.parse(readFileSync(statePath(dir), 'utf8')) as TrustState
}

function writeDurably(file: string, text: string) {
  const fd = openSync(file, 'w')
  try {
    writeSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function syncDir(dir: string) {
  try {
    const fd = openSync(dir, 'r')
    fsyncSync(fd)
    closeSync(fd)
  } catch {
    // Windows can't open a directory for fsync; NTFS journals the rename itself.
  }
}

/** Atomic and durable: flushed before the rename, so a crash leaves the old state or the new one. */
function save(dir: string, state: TrustState) {
  const tmp = `${statePath(dir)}.${process.pid}.tmp`
  writeDurably(tmp, `${JSON.stringify(state, null, 2)}\n`)
  renameSync(tmp, statePath(dir))
  syncDir(dir)
}

/** Like save, but fails if a state already exists: link, unlike rename, never replaces. */
function saveNew(dir: string, state: TrustState): boolean {
  const tmp = `${statePath(dir)}.${process.pid}.tmp`
  writeDurably(tmp, `${JSON.stringify(state, null, 2)}\n`)
  try {
    linkSync(tmp, statePath(dir))
    syncDir(dir)
    return true
  } catch (err) {
    if (errno(err) === 'EEXIST') return false
    throw err
  } finally {
    unlinkSync(tmp)
  }
}

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return errno(err) === 'EPERM'
  }
}

/**
 * One run at a time: load, accept and save must not interleave, or an update is lost. The lock
 * holds the owner's pid, so a run that was killed (or a reboot) doesn't jam production forever.
 * Two runs taking over the same stale lock at the same instant is still possible; the spike 2
 * agent is a single long-lived process, which removes that case.
 */
function acquire(lock: string): number | null {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lock, 'wx')
      writeSync(fd, String(process.pid))
      return fd
    } catch (err) {
      if (errno(err) !== 'EEXIST') throw err
      let holder = Number.NaN
      try {
        holder = Number(readFileSync(lock, 'utf8'))
      } catch {}
      const fresh = Date.now() - statSync(lock).mtimeMs < 60_000
      if (Number.isSafeInteger(holder) && holder > 0 ? isAlive(holder) : fresh) return null
      unlinkSync(lock)
    }
  }
  return null
}

const result = (r: { ok: true } | { ok: false; code: string; detail?: string }): Outcome =>
  r.ok
    ? { line: 'ACCEPTED', code: 0 }
    : { line: `REFUSED ${r.code}${r.detail ? ` (${r.detail})` : ''}`, code: 1 }

async function run(verb: string, dir: string, rest: string[]): Promise<Outcome> {
  if (verb === 'init') {
    // Nothing is typed in: the app's address, keys and numbers come in the pairing file,
    // covered by the fingerprint the person at the server confirms (decisions #31).
    mkdirSync(dir, { recursive: true })
    // Re-initialising would forget every accepted number and make old signed files valid again.
    const created = saveNew(dir, emptyState())
    return created
      ? { line: 'INITIALISED', code: 0 }
      : { line: 'REFUSED already-initialised', code: 1 }
  }
  if (verb !== 'command' && verb !== 'release') return { line: `unknown verb ${verb}`, code: 2 }

  const lock = join(dir, 'state.lock')
  const fd = acquire(lock)
  if (fd === null) return { line: 'BUSY', code: 3 }
  try {
    const state = load(dir)
    if (verb === 'command') {
      const [file, flag, fingerprint] = rest
      if (!file) return { line: 'usage', code: 2 }
      const command: unknown = JSON.parse(readFileSync(file, 'utf8'))
      const args = (command as { args?: { genesis?: boolean } } | null)?.args
      if (args?.genesis === true && flag !== '--confirm') {
        // The person at the server compares this with what the app shows before confirming.
        return {
          line: `FINGERPRINT ${await genesisFingerprint(command)}\nREFUSED fingerprint-not-confirmed`,
          code: 1,
        }
      }
      const r = await acceptCommand(state, command, {
        now: new Date(),
        confirmedFingerprint: flag === '--confirm' ? fingerprint : undefined,
      })
      if (r.ok) save(dir, r.state)
      return result(r)
    }
    const [file, bundleFile] = rest
    if (!file || !bundleFile) return { line: 'usage', code: 2 }
    const release: unknown = JSON.parse(readFileSync(file, 'utf8'))
    const r = await acceptRelease(state, release, new Uint8Array(readFileSync(bundleFile)), {
      now: new Date(),
    })
    if (r.ok) save(dir, r.state)
    return result(r)
  } finally {
    closeSync(fd)
    unlinkSync(lock)
  }
}

const [verb, dir, ...rest] = process.argv.slice(2)
let outcome: Outcome
try {
  outcome = verb && dir ? await run(verb, dir, rest) : { line: 'usage', code: 2 }
} catch (err) {
  // Fails closed: nothing was accepted, and the lock is already released.
  outcome = { line: `ERROR ${(err as Error).message}`, code: 2 }
}
console.log(outcome.line)
process.exit(outcome.code)
