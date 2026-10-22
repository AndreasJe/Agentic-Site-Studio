// The agent's state on disk: the trust state of trust.ts (keys, rule, counters #30, release and
// command numbers #34, frozen) plus what is unpacked and active. One file, written atomically and
// durably, so a crash leaves the old state or the new one.
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { emptyState, type TrustState } from '@site-studio/shared/release'
import { errno, type Writer } from './fsx.ts'

export type SmokeSummary = {
  release: number
  passed: boolean
  at: string
  switchedBack: boolean
  /** The release active after the test: the tested one, the previous one, or 0 (none). */
  activeAfter: number
  outcome: 'passed' | 'switched-back' | 'taken-offline'
}

export type InstalledCert = {
  names: string[]
  notBefore: string
  notAfter: string
  serial: string
  installedAt: string
}

export type AgentState = {
  version: 1
  trust: TrustState
  /** The release being served, 0 for none. */
  active: number
  /** Where an automatic switch-back goes (#6), 0 for none. */
  previous: number
  /** Release folders on disk, ascending. Activate may only go to one of these (#35). */
  kept: number[]
  lastSmoke: SmokeSummary | null
  /** Inbox files already handled, by name, so each upload is handled once. */
  processed: Record<string, { key: string }>
  cert: InstalledCert | null
}

export function newState(): AgentState {
  return {
    version: 1,
    trust: emptyState(),
    active: 0,
    previous: 0,
    kept: [],
    lastSmoke: null,
    processed: {},
    cert: null,
  }
}

export function loadState(file: string): AgentState | null {
  if (!existsSync(file)) return null
  const value = JSON.parse(readFileSync(file, 'utf8')) as AgentState
  if (value?.version !== 1 || typeof value.trust !== 'object') throw new Error('unknown state file')
  return value
}

export function saveState(writer: Writer, file: string, state: AgentState) {
  writer.json(file, state, 0o600)
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
 * One agent per home: two would interleave load, accept and save and lose an update. The lock
 * holds the owner's pid, so one left by a killed run (or a reboot) is taken over.
 */
export function acquireLock(writer: Writer, dir: string): () => void {
  const lock = writer.check(join(dir, 'agent.lock'))
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lock, 'wx')
      writeSync(fd, String(process.pid))
      closeSync(fd)
      return () => {
        try {
          unlinkSync(lock)
        } catch {}
      }
    } catch (err) {
      if (errno(err) !== 'EEXIST') throw err
      let holder = Number.NaN
      try {
        holder = Number(readFileSync(lock, 'utf8'))
      } catch {}
      const fresh = Date.now() - statSync(lock).mtimeMs < 60_000
      const held = Number.isSafeInteger(holder) && holder > 0 ? isAlive(holder) : fresh
      if (held) throw new Error(`another agent holds ${lock}`)
      unlinkSync(lock)
    }
  }
  throw new Error(`could not take ${lock}`)
}
