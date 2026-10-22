// The production agent (decisions #1, #6, #23–#35, #48; plan §13.3–§13.6). It reads a local inbox
// the app fills over SFTP and writes only to its outbox, its state and its release folders. It
// never connects to the app, or anywhere: the only socket it opens is its own web server's
// listening one. Trust decisions are trust.ts's (acceptRelease, acceptCommand); this file adds
// the bundle check, unpacking, the atomic switch, the smoke test with switch-back, certificates
// and reporting.
import {
  existsSync,
  type FSWatcher,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  type Stats,
  statfsSync,
  statSync,
  symlinkSync,
  watch,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { sha256 } from '@site-studio/shared/bytes'
import {
  acceptCommand,
  acceptRelease,
  BundleError,
  genesisFingerprint,
  hex,
  verifyBundle,
} from '@site-studio/shared/release'
import { checkCertificate, ensureKey, makeCsr, type TlsKey } from './certs.ts'
import { type AgentConfig, type ConfigInput, makeConfig, siteHost, sitePrefix } from './config.ts'
import { errno, inboxStat, isInside, readInboxFile, TEMP_PREFIX, Writer } from './fsx.ts'
import { SiteServer, siteCsp } from './server.ts'
import { smokeTest } from './smoke.ts'
import {
  type AgentState,
  acquireLock,
  loadState,
  newState,
  type SmokeSummary,
  saveState,
} from './state.ts'

export const AGENT_VERSION = (
  JSON.parse(readFileSync(join(import.meta.dir, '../package.json'), 'utf8')) as { version: string }
).version

const MAX_COMMAND_BYTES = 256 * 1024
const MAX_RELEASE_JSON_BYTES = 64 * 1024
const MAX_LOG_LINES = 1000
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/
const RELEASE_JSON = /^release-([1-9][0-9]{0,15})\.json$/
const RELEASE_TAR = /^release-([1-9][0-9]{0,15})\.tar$/

type Refused = { ok: false; code: string; detail?: string }
type Done = { ok: true } & Record<string, unknown>
type Outcome = Refused | Done

const refuse = (code: string, detail?: string): Refused => ({ ok: false, code, detail })
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

export type AgentOptions = ConfigInput & {
  /** The clock (tests). */
  now?: () => Date
  /** Where log lines also go; the console by default. */
  print?: (line: string) => void
  /** Tests only: the web server leaves out `dropHeader` (read per response), so the smoke test fails. */
  faults?: { dropHeader?: string }
}

export class Agent {
  readonly config: AgentConfig
  readonly csp: string
  private readonly now: () => Date
  private readonly print: (line: string) => void
  private readonly writer: Writer
  private readonly server: SiteServer
  private readonly dirs: {
    state: string
    releases: string
    tls: string
    current: string
    currentTmp: string
    currentOld: string
  }
  private state: AgentState = newState()
  private key: TlsKey | null = null
  private unlock: (() => void) | null = null
  private timers: ReturnType<typeof setInterval>[] = []
  private watcher: FSWatcher | null = null
  private busy: Promise<void> = Promise.resolve()
  private logLines: string[] = []
  private lastResult = new Map<string, string>()
  private diskUsed: number | null = null
  private shown = new Set<string>()

  constructor(opts: AgentOptions) {
    this.config = makeConfig(opts)
    this.now = opts.now ?? (() => new Date())
    this.print = opts.print ?? ((line) => console.log(line))
    const { home } = this.config
    this.dirs = {
      state: join(home, 'state'),
      releases: join(home, 'releases'),
      tls: join(home, 'state', 'tls'),
      current: join(home, 'current'),
      currentTmp: join(home, `${TEMP_PREFIX}current`),
      currentOld: join(home, `${TEMP_PREFIX}current-old`),
    }
    // Writable: the outbox, the state, the releases and the current link. Never the inbox.
    this.writer = new Writer(
      [
        this.config.outbox,
        this.dirs.state,
        this.dirs.releases,
        this.dirs.current,
        this.dirs.currentTmp,
        this.dirs.currentOld,
      ],
      [this.config.inbox],
    )
    if (isInside(this.config.inbox, home) || isInside(this.config.inbox, this.config.outbox)) {
      throw new Error('the inbox must not contain the agent home or the outbox')
    }
    this.csp = siteCsp(this.config.frameSrc)
    this.server = new SiteServer({
      hostname: this.config.hostname,
      port: this.config.port,
      prefix: sitePrefix(this.config.site),
      csp: this.csp,
      faults: opts.faults,
    })
  }

  get port(): number {
    return this.server.port
  }

  get secure(): boolean {
    return this.server.secure
  }

  /** A copy of the state, for tests and the CLI. */
  snapshot(): AgentState {
    return structuredClone(this.state)
  }

  private get statePath() {
    return join(this.dirs.state, 'state.json')
  }

  private releaseDir(n: number) {
    return join(this.dirs.releases, String(n))
  }

  async start() {
    for (const dir of [this.config.outbox, this.dirs.state, this.dirs.releases, this.dirs.tls]) {
      this.writer.mkdir(dir)
    }
    if (!existsSync(this.config.inbox)) throw new Error(`no inbox at ${this.config.inbox}`)
    this.unlock = acquireLock(this.writer, this.dirs.state)
    try {
      const loaded = loadState(this.statePath)
      if (loaded) this.state = loaded
      else this.commit({})
      this.recover()
      this.key = await ensureKey(this.writer, this.dirs.tls)
      if (!existsSync(this.csrPath())) await this.writeCsr()
      this.logLines = this.readLog()
      const tls = this.installedTls()
      this.server.maintenance = this.state.trust.maintenance === true
      this.server.start(tls)
      this.show(this.state.active)
      this.log('started', { version: AGENT_VERSION, active: this.state.active, tls: !!tls })
      this.heartbeat()
    } catch (err) {
      this.server.stop()
      this.unlock?.()
      this.unlock = null
      throw err
    }
    if (this.config.heartbeatMs > 0) {
      this.timers.push(setInterval(() => this.safeHeartbeat(), this.config.heartbeatMs))
    }
    if (this.config.pollMs > 0) {
      this.timers.push(setInterval(() => void this.scan(), this.config.pollMs))
      try {
        this.watcher = watch(this.config.inbox, () => void this.scan())
      } catch {
        // Polling covers file systems without change events.
      }
    }
  }

  async stop() {
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    this.watcher?.close()
    this.watcher = null
    await this.busy
    this.server.stop()
    this.unlock?.()
    this.unlock = null
  }

  /** The person at the server confirms the pairing fingerprint they compared (decisions #25). */
  confirmFingerprint(fingerprint: string) {
    if (!/^SHA256:[A-Za-z0-9_-]{43}$/.test(fingerprint)) throw new Error('not a fingerprint')
    this.writer.atomic(join(this.dirs.state, 'confirmed-fingerprint'), `${fingerprint}\n`, 0o600)
  }

  /** Handles everything new in the inbox, one item at a time. Calls queue behind each other. */
  scan(): Promise<void> {
    this.busy = this.busy
      .then(() => this.scanOnce())
      .catch((err) => this.log('error', { message: (err as Error).message }))
    return this.busy
  }

  // ---- inbox -----------------------------------------------------------------------------

  private async scanOnce() {
    const inbox = this.config.inbox
    const names = readdirSync(inbox, { withFileTypes: true })
      .filter((e) => e.isFile() && NAME.test(e.name) && !e.name.startsWith(TEMP_PREFIX))
      .map((e) => e.name)
    const present = new Set(names)
    // Forget files the app has cleared away, so the list stays small.
    const processed = Object.fromEntries(
      Object.entries(this.state.processed).filter(([name]) => present.has(name)),
    )
    if (Object.keys(processed).length !== Object.keys(this.state.processed).length) {
      this.commit({ processed })
    }

    const commands: { name: string; key: string; bytes: Uint8Array; order: number }[] = []
    const releases: { name: string; key: string; n: number }[] = []
    for (const name of names) {
      const path = join(inbox, name)
      // Never through a link: lstat, and only a regular file counts.
      const st = inboxStat(path)
      if (!st) continue
      const rel = RELEASE_JSON.exec(name)
      if (rel) {
        const tar = join(inbox, `release-${rel[1]}.tar`)
        let t: Stats
        try {
          t = lstatSync(tar)
        } catch (err) {
          if (errno(err) === 'ENOENT') continue // the bundle comes first; wait for it
          throw err
        }
        const key = `${st.size}:${st.mtimeMs}:${t.size}:${t.mtimeMs}`
        if (this.state.processed[name]?.key === key) continue
        if (!t.isFile()) {
          this.finish(
            name,
            key,
            'release',
            refuse('unknown-file', 'the bundle is not a regular file'),
          )
          continue
        }
        releases.push({ name, key, n: Number(rel[1]) })
        continue
      }
      if (RELEASE_TAR.test(name)) continue // handled with its release-<n>.json
      if (name.endsWith('.json')) {
        const read = readInboxFile(path, MAX_COMMAND_BYTES)
        if (!read.ok) {
          const key = `${read.size ?? st.size}:${read.mtimeMs ?? st.mtimeMs}`
          if (read.code === 'too-large' && this.state.processed[name]?.key !== key) {
            this.finish(name, key, 'command', refuse('too-large'))
          }
          continue // too large, or replaced by something that isn't a regular file
        }
        const bytes = read.bytes
        const key = `${read.size}:${read.mtimeMs}:${hex(await sha256(bytes))}`
        if (this.state.processed[name]?.key === key) continue
        let order = Number.MAX_SAFE_INTEGER
        try {
          const seq = (JSON.parse(new TextDecoder().decode(bytes)) as { sequence?: unknown })
            ?.sequence
          if (Number.isSafeInteger(seq)) order = seq as number
        } catch {}
        commands.push({ name, key, bytes, order })
        continue
      }
      const key = `${st.size}:${st.mtimeMs}`
      if (this.state.processed[name]?.key !== key) {
        this.finish(name, key, 'unknown', refuse('unknown-file'))
      }
    }

    // Commands first, in sequence order: a freeze that arrives with a release wins.
    commands.sort((a, b) => a.order - b.order || (a.name < b.name ? -1 : 1))
    for (const c of commands) {
      const outcome = await this.failClosed(() => this.handleCommand(c.bytes))
      // A pairing waiting for the fingerprint stays in the inbox until it is confirmed.
      const pending = !outcome.ok && outcome.code === 'fingerprint-not-confirmed'
      this.finish(c.name, pending ? null : c.key, 'command', outcome)
    }
    releases.sort((a, b) => a.n - b.n)
    for (const r of releases) {
      this.finish(r.name, r.key, 'release', await this.failClosed(() => this.handleRelease(r.n)))
    }
  }

  /**
   * An unexpected error (a full disk, say) refuses the item instead of retrying it forever; the
   * state on disk is whatever was last committed, which is always consistent.
   */
  private async failClosed(run: () => Promise<Outcome>): Promise<Outcome> {
    try {
      return await run()
    } catch (err) {
      try {
        for (const name of readdirSync(this.dirs.releases)) {
          if (name.startsWith(TEMP_PREFIX)) this.writer.remove(join(this.dirs.releases, name))
        }
      } catch {}
      this.log('error', { message: (err as Error).message })
      return refuse('error', (err as Error).message)
    }
  }

  /** Writes the item's result to the outbox and marks it handled (unless `key` is null). */
  private finish(name: string, key: string | null, kind: string, outcome: Outcome) {
    const result = { file: name, kind, ...outcome }
    const text = JSON.stringify(result)
    if (this.lastResult.get(name) !== text) {
      this.lastResult.set(name, text)
      const file = name.endsWith('.json') ? name : `${name}.json`
      this.writer.json(join(this.config.outbox, 'results', file), {
        ...result,
        at: this.now().toISOString(),
      })
      this.log(outcome.ok ? 'accepted' : 'refused', result)
    }
    if (key !== null) this.commit({ processed: { ...this.state.processed, [name]: { key } } })
    this.safeHeartbeat()
  }

  // ---- commands --------------------------------------------------------------------------

  private async handleCommand(bytes: Uint8Array): Promise<Outcome> {
    let command: unknown
    try {
      command = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    } catch {
      return refuse('malformed', 'not JSON')
    }
    const name = isObj(command) ? command.command : undefined
    const args = isObj(command) && isObj(command.args) ? command.args : {}
    let confirmed: string | undefined
    let fingerprint: string | undefined
    if (name === 'trust-keys' && args.genesis === true) {
      try {
        fingerprint = await genesisFingerprint(command)
      } catch {
        return refuse('malformed', 'genesis')
      }
      const file = join(this.dirs.state, 'confirmed-fingerprint')
      if (existsSync(file)) confirmed = readFileSync(file, 'utf8').trim()
    }
    const r = await acceptCommand(this.state.trust, command, {
      now: this.now(),
      confirmedFingerprint: confirmed,
    })
    if (!r.ok) {
      if (r.code === 'fingerprint-not-confirmed' && fingerprint) {
        if (!this.shown.has(fingerprint)) {
          this.shown.add(fingerprint)
          this.print(`FINGERPRINT ${fingerprint}  (compare it with the app, then confirm it here)`)
        }
        return refuse(r.code, fingerprint)
      }
      return refuse(r.code, r.detail)
    }

    if (name === 'activate') {
      const n = args.release as number
      // Only to a release still unpacked here (#35); further back is a new release.
      if (!this.state.kept.includes(n) || !existsSync(this.releaseDir(n))) {
        return refuse('not-kept', String(n))
      }
      this.commit({ trust: r.state })
      const smoke = await this.switchTo(n)
      return { ok: true, command: name, release: n, smoke }
    }

    if (name === 'cert') {
      const check = await checkCertificate(
        String(args.certificate),
        this.requireKey(),
        this.config.domains,
        this.now(),
      )
      if (!check.ok) return refuse(check.code, check.detail)
      this.writer.atomic(join(this.dirs.tls, 'cert.pem'), check.pem)
      const cert = {
        names: check.names,
        notBefore: check.notBefore,
        notAfter: check.notAfter,
        serial: check.serial,
        installedAt: this.now().toISOString(),
      }
      this.commit({ trust: r.state, cert })
      // Reload the web server with the new certificate; renewal is the same step (#3).
      this.server.start(this.installedTls())
      return { ok: true, command: name, certificate: cert }
    }

    if (name === 'csr') {
      this.commit({ trust: r.state })
      const file = await this.writeCsr()
      return { ok: true, command: name, csr: file }
    }

    // freeze, unfreeze, maintenance, trust-keys (with genesis), remove-key: trust state only.
    this.commit({ trust: r.state })
    const maintenance = r.state.maintenance === true
    if (name === 'maintenance') {
      // Visitors get the maintenance page (or the site) from the next request on (#50).
      this.server.maintenance = maintenance
      this.log(maintenance ? 'maintenance-on' : 'maintenance-off')
    }
    return {
      ok: true,
      command: name,
      frozen: r.state.frozen,
      ...(name === 'maintenance' ? { maintenance } : {}),
      ...(fingerprint ? { fingerprint } : {}),
    }
  }

  // ---- releases --------------------------------------------------------------------------

  private async handleRelease(n: number): Promise<Outcome> {
    const json = join(this.config.inbox, `release-${n}.json`)
    const tar = join(this.config.inbox, `release-${n}.tar`)
    const jsonRead = readInboxFile(json, MAX_RELEASE_JSON_BYTES)
    if (!jsonRead.ok)
      return jsonRead.code === 'too-large'
        ? refuse('too-large', 'release.json')
        : refuse('unknown-file', 'release.json is not a regular file')
    const tarRead = readInboxFile(tar, this.config.maxBundleBytes)
    if (!tarRead.ok)
      return tarRead.code === 'too-large'
        ? refuse('too-large', 'bundle')
        : refuse('unknown-file', 'the bundle is not a regular file')
    let release: unknown
    try {
      release = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(jsonRead.bytes))
    } catch {
      return refuse('malformed', 'not JSON')
    }
    if (!isObj(release) || release.releaseNumber !== n) {
      return refuse('malformed', 'the file name and releaseNumber differ')
    }
    const bundle = tarRead.bytes
    // Signatures, the bundle hash, the release number, the target (#27), validUntil (#29),
    // frozen (#33) and the two-person rule: all in trust.ts.
    const r = await acceptRelease(this.state.trust, release, bundle, { now: this.now() })
    if (!r.ok) return refuse(r.code, r.detail)
    let verified: Awaited<ReturnType<typeof verifyBundle>>
    try {
      verified = await verifyBundle(bundle)
    } catch (err) {
      if (!(err instanceof BundleError || err instanceof SyntaxError)) throw err
      const code = err.message.includes('packageHash') ? 'package-hash-mismatch' : 'bad-bundle'
      return refuse(code, err.message)
    }
    const { manifest } = verified
    if (manifest.site !== this.config.site) return refuse('wrong-site', manifest.site)

    this.unpack(n, verified)
    // Accepted: the number, the counters and the release entry are on disk before the switch.
    this.commit({ trust: r.state, kept: [...this.state.kept, n].sort((a, b) => a - b) })
    const smoke = await this.switchTo(n)
    this.prune()
    return {
      ok: true,
      release: n,
      project: manifest.project,
      revision: manifest.revision,
      site: manifest.site,
      packageHash: manifest.packageHash,
      smoke,
    }
  }

  /** site.tar into releases/<n>/ via a temp folder, then one rename. Never over a kept one. */
  private unpack(n: number, verified: Awaited<ReturnType<typeof verifyBundle>>) {
    const final = this.releaseDir(n)
    const tmp = join(this.dirs.releases, `${TEMP_PREFIX}${n}`)
    this.writer.remove(tmp)
    if (existsSync(final)) {
      if (this.state.kept.includes(n) || this.state.active === n) {
        throw new Error(`release ${n} is already unpacked`)
      }
      this.writer.remove(final) // left over from a crash before its state was saved
    }
    this.writer.mkdir(tmp)
    for (const e of verified.files) {
      const target = resolve(tmp, ...e.path.split('/'))
      if (!isInside(tmp, target) || target === resolve(tmp)) throw new Error(`bad path ${e.path}`)
      this.writer.create(target, verified.site.subarray(e.offset, e.offset + e.size))
    }
    this.writer.rename(tmp, final)
    this.diskUsed = null
  }

  /**
   * Makes `n` active, runs the smoke test, and on failure switches back to the release that was
   * active before, with no new signature (#6). With nothing to go back to, the site goes offline
   * rather than serve a release that failed.
   */
  private async switchTo(n: number): Promise<SmokeSummary> {
    const from = this.state.active
    this.commit({ active: n, previous: from !== n ? from : this.state.previous })
    this.show(n)
    const result = await smokeTest(this.server, this.releaseDir(n), this.server.listed, {
      prefix: sitePrefix(this.config.site),
      csp: this.csp,
    })
    let activeAfter = n
    let outcome: SmokeSummary['outcome'] = 'passed'
    if (!result.passed) {
      const back =
        from !== n &&
        from > 0 &&
        this.state.kept.includes(from) &&
        existsSync(this.releaseDir(from))
          ? from
          : 0
      activeAfter = back
      outcome = back ? 'switched-back' : 'taken-offline'
      this.commit({ active: back, previous: 0 })
      this.show(back)
    }
    const summary: SmokeSummary = {
      release: n,
      passed: result.passed,
      at: this.now().toISOString(),
      switchedBack: outcome === 'switched-back',
      activeAfter,
      outcome,
    }
    this.commit({ lastSmoke: summary })
    this.writer.json(join(this.config.outbox, 'smoke', `${n}.json`), {
      ...summary,
      pages: result.pages,
    })
    this.log(outcome, { release: n, activeAfter })
    return summary
  }

  /** Serve `n` (0: nothing) and point the current link at it. */
  private show(n: number) {
    const dir = n > 0 && existsSync(this.releaseDir(n)) ? this.releaseDir(n) : null
    this.server.serve(dir)
    this.pointCurrent(dir ? n : 0)
  }

  /**
   * `current` → releases/<n>: a new link under a temp name, renamed over the old one. That is
   * atomic for a symlink on Linux. Windows can't rename a junction over another, so there the old
   * one is moved aside first; the agent's own server never reads the link, and start-up rebuilds
   * it from the state, so a crash in between leaves nothing wrong behind.
   */
  private pointCurrent(n: number) {
    const link = this.dirs.current
    const exists = (p: string) => {
      try {
        lstatSync(p)
        return true
      } catch {
        return false
      }
    }
    if (n === 0) {
      if (exists(link)) this.writer.unlink(link)
      return
    }
    const windows = process.platform === 'win32'
    const target = windows ? this.releaseDir(n) : join('releases', String(n))
    if (exists(link)) {
      try {
        if (readlinkSync(link).replace(/[\\/]+$/, '') === target) return
      } catch {}
    }
    const tmp = this.dirs.currentTmp
    if (exists(tmp)) this.writer.unlink(tmp)
    symlinkSync(target, tmp, windows ? 'junction' : 'dir')
    try {
      this.writer.rename(tmp, link)
    } catch (err) {
      if (!windows) throw err
      const aside = this.dirs.currentOld
      if (exists(aside)) this.writer.unlink(aside)
      if (exists(link)) this.writer.rename(link, aside)
      this.writer.rename(tmp, link)
      if (exists(aside)) this.writer.unlink(aside)
    }
  }

  /** Keep the newest K releases plus the active and previous ones; forget the rest (#35). */
  private prune() {
    const newest = [...this.state.kept].sort((a, b) => b - a).slice(0, this.config.keep)
    const keep = new Set([...newest, this.state.active, this.state.previous])
    const drop = this.state.kept.filter((n) => !keep.has(n))
    if (drop.length === 0) return
    const releases = { ...this.state.trust.releases }
    for (const n of drop) delete releases[String(n)]
    // State first: if removal is interrupted, a folder is left over, never a kept entry without one.
    this.commit({
      kept: this.state.kept.filter((n) => keep.has(n)),
      trust: { ...this.state.trust, releases },
    })
    for (const n of drop) this.writer.remove(this.releaseDir(n))
    this.diskUsed = null
    this.log('pruned', { releases: drop })
  }

  /** After a crash: drop temp folders and folders the state doesn't know, rebuild the link. */
  private recover() {
    for (const e of readdirSync(this.dirs.releases, { withFileTypes: true })) {
      const n = Number(e.name)
      const known = Number.isSafeInteger(n) && this.state.kept.includes(n)
      if (!known) this.writer.remove(join(this.dirs.releases, e.name))
    }
    for (const n of [this.state.active, this.state.previous]) {
      if (n > 0 && !this.state.kept.includes(n)) throw new Error(`state names missing release ${n}`)
    }
  }

  // ---- certificates ----------------------------------------------------------------------

  private requireKey(): TlsKey {
    if (!this.key) throw new Error('no TLS key')
    return this.key
  }

  private csrPath() {
    return join(this.config.outbox, 'csr', `${siteHost(this.config.site)}.pem`)
  }

  private async writeCsr(): Promise<string> {
    const pem = await makeCsr(this.requireKey(), this.config.domains)
    this.writer.atomic(this.csrPath(), pem)
    return `csr/${siteHost(this.config.site)}.pem`
  }

  private installedTls() {
    const file = join(this.dirs.tls, 'cert.pem')
    if (!this.state.cert || !existsSync(file) || !this.key) return null
    return { cert: readFileSync(file, 'utf8'), key: this.key.keyPem }
  }

  // ---- outbox reporting ------------------------------------------------------------------

  private commit(patch: Partial<AgentState>) {
    this.state = { ...this.state, ...patch }
    saveState(this.writer, this.statePath, this.state)
  }

  private readLog(): string[] {
    const file = join(this.config.outbox, 'log.jsonl')
    if (!existsSync(file)) return []
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-MAX_LOG_LINES)
  }

  /** log.jsonl: the newest lines, rewritten atomically so the app never reads half a line. */
  private log(event: string, data: Record<string, unknown> = {}) {
    const line = JSON.stringify({ at: this.now().toISOString(), event, ...data })
    this.print(line)
    this.logLines.push(line)
    if (this.logLines.length > MAX_LOG_LINES)
      this.logLines.splice(0, this.logLines.length - MAX_LOG_LINES)
    try {
      this.writer.atomic(join(this.config.outbox, 'log.jsonl'), `${this.logLines.join('\n')}\n`)
    } catch (err) {
      this.print(`log write failed: ${(err as Error).message}`)
    }
  }

  private dirSize(dir: string): number {
    let total = 0
    for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
      if (e.isFile()) total += statSync(join(e.parentPath, e.name)).size
    }
    return total
  }

  private safeHeartbeat() {
    try {
      this.heartbeat()
    } catch (err) {
      this.print(`heartbeat failed: ${(err as Error).message}`)
    }
  }

  /** heartbeat.json (contracts/heartbeat.schema.json, plus the numbers a re-pairing needs, #34). */
  heartbeat() {
    this.diskUsed ??= this.dirSize(this.dirs.releases)
    let totalBytes: number | undefined
    let freeBytes: number | undefined
    try {
      const fs = statfsSync(this.config.home)
      totalBytes = fs.blocks * fs.bsize
      freeBytes = fs.bavail * fs.bsize
    } catch {}
    const { trust } = this.state
    const csrDir = join(this.config.outbox, 'csr')
    const smoke = this.state.lastSmoke
    this.writer.json(join(this.config.outbox, 'heartbeat.json'), {
      at: this.now().toISOString(),
      agentVersion: AGENT_VERSION,
      target: trust.target || null,
      site: this.config.site,
      paired: trust.keys.length > 0,
      activeRelease: this.state.active,
      previousRelease: this.state.previous,
      keptReleases: this.state.kept,
      frozen: trust.frozen,
      maintenance: trust.maintenance === true,
      highestRelease: trust.highestRelease,
      lastSequence: trust.lastSequence,
      disk: { usedBytes: this.diskUsed, totalBytes, freeBytes },
      lastSmokeTest: smoke
        ? {
            release: smoke.release,
            passed: smoke.passed,
            at: smoke.at,
            switchedBack: smoke.switchedBack,
          }
        : undefined,
      certificateRequests: existsSync(csrDir)
        ? readdirSync(csrDir)
            .filter((f) => f.endsWith('.pem') && !f.startsWith(TEMP_PREFIX))
            .map((f) => `csr/${f}`)
        : [],
      certificate: this.state.cert
        ? { names: this.state.cert.names, notAfter: this.state.cert.notAfter }
        : null,
      tls: this.server.secure,
    })
  }
}
