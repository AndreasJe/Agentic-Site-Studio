<script lang="ts">
// Deployment (plan §13.4, §13.6, §13.11; design/prototype/AdminDeployment.dc.html; M7.9). Admin
// only. Targets and their health (read from production's outbox, never by calling in), the pairing
// wizard, sites and hostnames, releases and rollback, certificates and the kill switch. Production
// never connects to the app: everything here is files in its inbox and reads of its outbox.
// Rollback and unfreezing need an Admin's passkey; freezing is the app's own signature.
import AdminShell from '../components/AdminShell.svelte'
import Icon from '../components/Icon.svelte'
import { ad, afill, codeText } from '../lib/admin-strings.ts'
import { api } from '../lib/api.ts'
import { assertWithPasskey } from '../lib/passkey.ts'
import { session } from '../lib/session.svelte.ts'
import { ageSeconds, type SignOptions, type SigningView, signAndSend, when } from '../lib/signing.ts'

type Target = {
  target: string
  kind: 'sftp' | 'folder'
  host: string | null
  port: number | null
  hostFingerprintSeen: string | null
  hostFingerprintPinned: string | null
  domains: string[]
  status: 'connecting' | 'pinned' | 'prepared' | 'sent' | 'paired'
  fingerprint: string | null
  lastSequence: number
  lastRelease: number
}
type Heartbeat = {
  at: string
  agentVersion: string | null
  site: string | null
  paired: boolean
  frozen: boolean
  activeRelease: number | null
  previousRelease: number | null
  keptReleases: number[]
  highestRelease: number | null
  disk: { usedBytes: number | null; totalBytes: number | null }
  lastSmokeTest: { release: number | null; passed: boolean; switchedBack: boolean; at: string | null } | null
  tls: boolean
}
type Command = { purpose: string } & SigningView
type Detail = { paired: boolean; heartbeat: Heartbeat | null; commands: Command[] }
type Cert = {
  target: string
  host: string
  names: string[]
  issuedAt: string | null
  notAfter: string | null
  status: string
  error: string | null
}
type Address = { project: string; name: string; approvedBy: string; at: string }

const TABS = ['targets', 'sites', 'releases', 'certs', 'kill'] as const
const LATE_S = 90
const UNREACHABLE_S = 600

const s = $derived(ad())
const isAdmin = $derived(session.user?.role === 'admin')

let view = $state<'loading' | 'ok' | 'failed'>('loading')
let tab = $state<(typeof TABS)[number]>('targets')
let targets = $state<Target[]>([])
let details = $state<Record<string, Detail>>({})
let certs = $state<Cert[]>([])
let addresses = $state<Address[]>([])
let notes = $state<Record<string, { text: string; ok: boolean }>>({})
let busy = $state<string | null>(null)
let now = $state(Date.now())

async function load() {
  const [t, c, a] = await Promise.all([
    api<{ targets: Target[] }>('GET', '/api/deploy/targets'),
    api<{ certificates: Cert[] }>('GET', '/api/deploy/certificates'),
    api<{ addresses: Address[] }>('GET', '/api/deploy/addresses'),
  ])
  if (!t.ok) {
    view = 'failed'
    return
  }
  targets = t.body.targets ?? []
  certs = c.ok ? (c.body.certificates ?? []) : []
  addresses = a.ok ? (a.body.addresses ?? []) : []
  const next: Record<string, Detail> = {}
  await Promise.all(
    targets.map(async (x) => {
      const d = await api<Detail>('GET', `/api/admin/commands/${x.target}`)
      if (d.ok) next[x.target] = d.body
    }),
  )
  details = next
  now = Date.now()
  view = 'ok'
}

$effect(() => {
  if (isAdmin) load()
})

const note = (key: string, text: string, ok = false) => {
  notes[key] = { text, ok }
}

// ---- health -----------------------------------------------------------------------------
function health(t: Target): 'healthy' | 'late' | 'unreachable' | 'frozen' | 'unpaired' {
  const hb = details[t.target]?.heartbeat ?? null
  if (t.status !== 'paired') return 'unpaired'
  if (!hb) return 'unreachable'
  const age = ageSeconds(hb.at, now)
  if (age > UNREACHABLE_S) return 'unreachable'
  if (hb.frozen) return 'frozen'
  return age > LATE_S ? 'late' : 'healthy'
}
function ago(iso: string | null | undefined): string {
  const sec = ageSeconds(iso, now)
  if (!Number.isFinite(sec)) return ''
  if (sec < 90) return afill(s.dpAgo.s ?? '', { n: Math.round(sec) })
  if (sec < 5400) return afill(s.dpAgo.m ?? '', { n: Math.round(sec / 60) })
  if (sec < 172800) return afill(s.dpAgo.h ?? '', { n: Math.round(sec / 3600) })
  return afill(s.dpAgo.d ?? '', { n: Math.round(sec / 86400) })
}
const bytes = (n: number | null) =>
  n === null ? '?' : n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`
const pairedTargets = $derived(targets.filter((t) => t.status === 'paired'))
const smokeText = (h: Heartbeat) => {
  const x = h.lastSmokeTest
  if (!x) return ''
  const n = x.release ?? 0
  return x.passed ? afill(s.dpSmokePassed, { n }) : afill(x.switchedBack ? s.dpSmokeBack : s.dpSmokeFailed, { n })
}

// ---- pairing wizard ---------------------------------------------------------------------
let wizOpen = $state(false)
let step = $state(1)
let wName = $state('production')
let wHost = $state('')
let wPort = $state('22')
let wUser = $state('app')
let wDomains = $state('')
let wKeys = $state<{ ssh: string; signing: string } | null>(null)
let wSeen = $state<string | null>(null)
let wPinned = $state(false)
let wPrep = $state<{
  fingerprint: string
  admins: string[]
  assertion: { challenge: string; rpId: string; allowCredentials: string[]; userVerification: string }
} | null>(null)
let wSigning = $state(false)
let wSent = $state(false)
let wPaired = $state(false)
let wError = $state('')

function openWizard(t?: Target) {
  wizOpen = true
  wError = ''
  wPrep = null
  wSent = false
  wPaired = false
  wPinned = false
  wSeen = null
  if (t) {
    wName = t.target
    wHost = t.host ?? ''
    wPort = String(t.port ?? 22)
    wSeen = t.hostFingerprintSeen
    wPinned = !!t.hostFingerprintPinned
    step = t.status === 'connecting' ? 3 : 4
    wSent = t.status === 'sent'
  } else {
    wName = 'production'
    wHost = ''
    step = 1
  }
  if (!wKeys) api<{ keys: { ssh: string; signing: string } }>('GET', '/api/deploy/keys').then((r) => {
    if (r.ok) wKeys = r.body.keys
  })
}

const nameOk = $derived(/^[a-z][a-z0-9-]{0,31}$/.test(wName))
const domainList = $derived(
  wDomains
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean),
)
const step1Ok = $derived(nameOk && wHost.trim().length > 0 && domainList.length > 0)
const nextDisabled = $derived((step === 1 && !step1Ok) || (step === 3 && !wPinned) || step >= 4)

async function connect() {
  wError = ''
  busy = 'connect'
  const domains = domainList
  const r = await api<{ hostFingerprint?: string; code?: string; message?: string }>(
    'POST',
    `/api/deploy/targets/${wName}/connect`,
    {
      target: wName,
      kind: 'sftp',
      host: wHost.trim(),
      port: Number(wPort),
      username: wUser.trim(),
      domains,
    },
  )
  busy = null
  if (!r.ok) {
    wError = codeText(r.body.code) === s.errGeneric ? (r.body.message ?? s.errGeneric) : codeText(r.body.code)
    return
  }
  wSeen = r.body.hostFingerprint ?? null
  wPinned = false
}

async function pin() {
  if (!wSeen) return
  wError = ''
  busy = 'pin'
  const r = await api<{ code?: string }>('POST', `/api/deploy/targets/${wName}/pin-host`, { fingerprint: wSeen })
  busy = null
  if (!r.ok) {
    wError = codeText(r.body.code)
    return
  }
  wPinned = true
  await load()
}

async function prepare() {
  wError = ''
  busy = 'prepare'
  const r = await api<{
    fingerprint: string
    admins: string[]
    assertion: NonNullable<typeof wPrep>['assertion']
    code?: string
  }>('POST', `/api/deploy/targets/${wName}/pairing/prepare`, {})
  busy = null
  if (!r.ok) {
    wError = codeText(r.body.code)
    return
  }
  wPrep = r.body
}

async function confirmPairing() {
  if (!wPrep) return
  wError = ''
  wSigning = true
  const a = await assertWithPasskey({
    challenge: wPrep.assertion.challenge,
    rpId: wPrep.assertion.rpId,
    userVerification: wPrep.assertion.userVerification,
    allowCredentials: wPrep.assertion.allowCredentials.map((id) => ({ id })),
  })
  if (!a.ok) {
    wSigning = false
    wError = codeText(a.code)
    return
  }
  const r = await api<{ code?: string }>('POST', `/api/deploy/targets/${wName}/pairing/confirm`, a.assertion)
  wSigning = false
  if (!r.ok) {
    wError = codeText(r.body.code)
    return
  }
  wSent = true
  await load()
}

async function refreshTarget(name: string) {
  busy = `refresh-${name}`
  const r = await api<{ target?: Target; code?: string }>('POST', `/api/deploy/targets/${name}/refresh`, {})
  busy = null
  if (r.ok && r.body.target?.status === 'paired' && name === wName) wPaired = true
  if (!r.ok) note(`refresh-${name}`, codeText(r.body.code))
  await load()
}

// ---- releases, rollback, kill switch ------------------------------------------------------
async function activate(target: string, release: number) {
  if (busy) return
  busy = `activate-${release}`
  note('release', afill(s.dpRelWaiting, { n: release }), true)
  const r = await api<SignOptions & { code?: string }>('POST', `/api/admin/commands/${target}/activate`, { release })
  if (!r.ok) {
    busy = null
    note('release', codeText(r.body.code))
    return
  }
  const done = await signAndSend(r.body)
  busy = null
  if (done.ok) note('release', afill(s.dpRelSent, { n: release }), true)
  else note('release', codeText(done.code))
  await load()
}

async function freeze(target: string) {
  if (busy) return
  busy = 'freeze'
  const r = await api<{ sequence?: number; code?: string }>('POST', `/api/admin/commands/${target}/freeze`, {})
  busy = null
  if (r.ok) note('kill', afill(s.dpFreezeSent, { n: r.body.sequence ?? '' }), true)
  else note('kill', codeText(r.body.code))
  await load()
}

async function unfreeze(target: string) {
  if (busy) return
  busy = 'unfreeze'
  note('kill', s.dpUnfreezeSign, true)
  const r = await api<SignOptions & { code?: string }>('POST', `/api/admin/commands/${target}/unfreeze`, {})
  if (!r.ok) {
    busy = null
    note('kill', codeText(r.body.code))
    return
  }
  const done = await signAndSend(r.body)
  busy = null
  if (done.ok) note('kill', afill(s.dpUnfreezeSent, { n: done.reply.body.signing?.sequence ?? '' }), true)
  else note('kill', codeText(done.code))
  await load()
}

async function runCerts() {
  busy = 'certs'
  const r = await api<{ requested: string[]; renewed: string[]; warned: string[]; failed: string[]; code?: string }>(
    'POST',
    '/api/deploy/certificates/run',
    {},
  )
  busy = null
  if (r.ok)
    note(
      'certs',
      afill(s.dpCertRan, { a: r.body.requested.length, b: r.body.renewed.length, c: r.body.warned.length, d: r.body.failed.length }),
      true,
    )
  else note('certs', codeText(r.body.code))
  await load()
}

const releaseRows = (h: Heartbeat) => {
  const all = new Set<number>([...(h.keptReleases ?? [])])
  if (h.activeRelease !== null) all.add(h.activeRelease)
  if (h.previousRelease !== null) all.add(h.previousRelease)
  return [...all].sort((a, b) => b - a)
}
const releaseState = (h: Heartbeat, n: number) =>
  n === h.activeRelease ? s.dpRelActive : n === h.previousRelease ? s.dpRelPrevious : s.dpRelKept
</script>

<AdminShell
  heading={s.dpHeading}
  kicker={s.kicker}
  sub={s.dpSub}
  active="deployment"
  did={s.dpDid}
  state={view}
>
  <div class="tabs" role="group" aria-label={s.dpTabsAria}>
    <button type="button" aria-pressed={tab === 'targets'} onclick={() => (tab = 'targets')}>{s.dpTabTargets}</button>
    <button type="button" aria-pressed={tab === 'sites'} onclick={() => (tab = 'sites')}>{s.dpTabSites}</button>
    <button type="button" aria-pressed={tab === 'releases'} onclick={() => (tab = 'releases')}>{s.dpTabReleases}</button>
    <button type="button" aria-pressed={tab === 'certs'} onclick={() => (tab = 'certs')}>{s.dpTabCerts}</button>
    <button type="button" aria-pressed={tab === 'kill'} onclick={() => (tab = 'kill')}>{s.dpTabKill}</button>
  </div>

  {#if tab === 'targets'}
    <div class="stack" style="gap: 24px">
      {#if wizOpen}
        <section class="card ink rise" aria-labelledby="wiz-h" data-testid="wizard">
          <div class="card-h">
            <Icon name="server" />
            <h2 id="wiz-h" class="h2s" style="font-size: 22px">{s.dpWizH}</h2>
            <span class="mono small muted" style="margin-left: auto">{afill(s.dpWizStep, { n: step })}</span>
          </div>
          <div class="card-b" style="gap: 18px">
            <ol class="wsteps">
              {#each s.dpWizSteps as label, i (label)}
                <li class:now={step === i + 1} class:done={step > i + 1}><span class="mono">0{i + 1}</span><span>{label}</span></li>
              {/each}
            </ol>

            {#if step === 1}
              <div class="stack rise">
                <div class="field" style="max-width: 420px">
                  <label for="tname">{s.dpWizName}</label>
                  <input id="tname" class="input" bind:value={wName} autocomplete="off" />
                  <span class="small muted">{s.dpWizNameHelp}</span>
                </div>
                <div class="flabel">{s.dpWizType}</div>
                <div class="choice" style="cursor: default" aria-label={s.dpWizSeparate}>
                  <span class="row"><Icon name="server" /><b>{s.dpWizSeparate}</b><span class="chip">SFTP</span></span>
                  <span class="small muted">{s.dpWizSeparateText}</span>
                </div>
                <div class="fgrid">
                  <div class="field"><label for="whost">{s.dpWizHost}</label><input id="whost" class="input" bind:value={wHost} autocomplete="off" /></div>
                  <div class="field"><label for="wport">{s.dpWizPort}</label><input id="wport" class="input mono" bind:value={wPort} inputmode="numeric" /></div>
                  <div class="field"><label for="wuser">{s.dpWizUser}</label><input id="wuser" class="input" bind:value={wUser} autocomplete="off" /></div>
                  <div class="field"><label for="wdom">{s.dpWizDomains}</label><input id="wdom" class="input" bind:value={wDomains} autocomplete="off" /><span class="small muted">{s.dpWizDomainsHelp}</span></div>
                </div>
              </div>
            {:else if step === 2}
              <div class="stack rise">
                <p>{afill(s.dpWizInstall, { name: wName })}</p>
                <h3 class="label">{s.dpWizKeys}</h3>
                <div class="kv">
                  <div><span class="label">{s.dpWizSshKey}</span><span class="mono small">{wKeys?.ssh ?? '…'}</span></div>
                  <div><span class="label">{s.dpWizSigningKey}</span><span class="mono small">{wKeys?.signing ?? '…'}</span></div>
                </div>
                <p class="small muted">{s.dpWizKeysNote}</p>
              </div>
            {:else if step === 3}
              <div class="stack rise">
                <div class="pkpanel" role="status">
                  <Icon name="server" />
                  <div class="stack" style="gap: 2px; flex: 1 1 300px"><b>{s.dpWizConnect}</b><span class="small muted">{afill(s.dpWizConnectText, { host: wHost, port: wPort })}</span></div>
                  <button type="button" class="btn" disabled={busy === 'connect' || !step1Ok} onclick={connect}>{busy === 'connect' ? s.dpWizConnecting : s.dpWizConnect}</button>
                </div>
                {#if wSeen}
                  <div class="stack rise" style="gap: 12px">
                    <div class="row"><span class="chip ok">{s.dpWizConnected}</span></div>
                    <p>{s.dpWizCompare}</p>
                    <div class="kv">
                      <div><span class="label">{s.dpWizHost}</span><span class="mono">{wHost}</span></div>
                      <div><span class="label">{s.dpWizHostKey}</span><span class="mono" data-testid="host-key">{wSeen}</span></div>
                    </div>
                    <p class="small muted">{s.dpWizHostKeyWarn}</p>
                    {#if wPinned}
                      <span class="chip ok"><Icon name="check" small />{s.dpWizPinned}</span>
                    {:else}
                      <div class="row"><button type="button" class="btn" disabled={busy === 'pin'} onclick={pin}>{s.dpWizPin}</button></div>
                    {/if}
                  </div>
                {/if}
              </div>
            {:else}
              <div class="stack rise">
                <p>{s.dpWizPrepareText}</p>
                {#if wPaired}
                  <div class="row rise" style="gap: 16px">
                    <Icon name="check" />
                    <div class="stack" style="gap: 2px"><b>{afill(s.dpWizPaired, { name: wName })}</b><span class="small muted">{s.dpWizPairedText}</span></div>
                  </div>
                {:else if wSent}
                  <div class="passkey" role="status">
                    <b>{s.dpWizSent}</b>
                    <p class="small muted">{s.dpWizSentText}</p>
                    <div class="row"><button type="button" class="btn" disabled={busy === `refresh-${wName}`} onclick={() => refreshTarget(wName)}>{s.dpRefresh}</button></div>
                  </div>
                {:else if !wPrep}
                  <div class="row"><button type="button" class="btn" disabled={busy === 'prepare'} onclick={prepare}>{s.dpWizPrepare}</button></div>
                {:else}
                  <div class="stack" style="gap: 8px">
                    <span class="label">{s.dpWizFingerprint}</span>
                    <span class="mono" data-testid="pair-fingerprint">{wPrep.fingerprint}</span>
                    <p class="small muted">{s.dpWizFingerprintText}</p>
                    <p class="small muted">{afill(s.dpWizAdmins, { names: wPrep.admins.join(', ') })}</p>
                  </div>
                  {#if wSigning}
                    <div class="pkpanel rise" role="status"><Icon name="passkey" /><div class="stack" style="gap: 2px; flex: 1 1 300px"><b>{s.touch}</b><span class="mono small muted">{afill(s.dpWizSigning, { name: wName, fp: wPrep.fingerprint })}</span></div></div>
                  {/if}
                {/if}
              </div>
            {/if}
            {#if wError}<p class="amsg" role="alert">{wError}</p>{/if}
          </div>
          <div class="card-f">
            <span class="note">{s.dpWizNote}</span>
            <button type="button" class="btn quiet" onclick={() => (wizOpen = false)}>{s.dpWizClose}</button>
            {#if step > 1 && !wSent}<button type="button" class="btn" onclick={() => (step -= 1)}>{s.back}</button>{/if}
            {#if step < 4}
              <button type="button" class="btn primary" disabled={nextDisabled && step !== 2} onclick={() => (step += 1)}>{s.next}</button>
            {:else if wPrep && !wSent && !wPaired}
              <button type="button" class="btn primary" disabled={wSigning} onclick={confirmPairing}><Icon name="passkey" small />{s.dpWizConfirm}</button>
            {/if}
          </div>
        </section>
      {/if}

      {#if targets.length === 0}<p class="muted">{s.dpNoTargets}</p>{/if}

      {#each targets as t (t.target)}
        {@const d = details[t.target]}
        {@const h = d?.heartbeat ?? null}
        {@const hl = health(t)}
        <section class="card" aria-labelledby="t-{t.target}" data-testid="target-{t.target}">
          <div class="card-h">
            <Icon name="server" />
            <h2 id="t-{t.target}" class="h2s" style="font-size: 22px">{t.target}</h2>
            <span class="chip">{s.dpKind[t.kind] ?? t.kind}</span>
            <span class="chip" class:ok={hl === 'healthy'} class:warn={hl === 'late' || hl === 'unreachable'} class:sig={hl === 'frozen'} data-testid="health-{t.target}">{s.dpHealth[hl]}</span>
            <span class="small muted" style="margin-left: auto">{t.host ? `${t.host}${t.port ? `:${t.port}` : ''}` : ''}</span>
          </div>
          <div class="card-b" style="gap: 20px">
            <div class="stack" style="gap: 10px">
              <h3 class="label">{s.dpHealthH}</h3>
              <p class="small muted">{afill(s.dpHealthNote, { n: UNREACHABLE_S / 60 })}</p>
              <div class="kv">
                <div><span class="small muted">{s.dpHeartbeat}</span><span class="mono">{h ? afill(s.dpHeartbeatAge, { age: ago(h.at) }) : s.dpHeartbeatNone}</span></div>
                <div><span class="small muted">{s.dpAgent}</span><span class="mono">{h?.agentVersion ?? '—'}</span></div>
                <div><span class="small muted">{s.dpDisk}</span><span class="mono">{h ? afill(s.dpDiskValue, { used: bytes(h.disk.usedBytes), total: bytes(h.disk.totalBytes) }) : '—'}</span></div>
                <div><span class="small muted">{s.dpSmoke}</span><span class="mono">{h?.lastSmokeTest ? smokeText(h) : '—'}</span></div>
                <div><span class="small muted">{s.dpActive}</span><span class="mono">{h?.activeRelease != null ? afill(s.dpReleaseN, { n: h.activeRelease }) : '—'}</span></div>
                <div><span class="small muted">{s.dpTls}</span><span class="mono">{h ? (h.tls ? s.dpTlsOn : s.dpTlsOff) : '—'}</span></div>
              </div>
            </div>
            <div class="row">
              <span class="chip">{s.dpStatus[t.status]}</span>
              {#if t.status !== 'paired'}<button type="button" class="btn" onclick={() => openWizard(t)}>{s.dpContinue}</button>{/if}
              <button type="button" class="btn" disabled={busy === `refresh-${t.target}`} onclick={() => refreshTarget(t.target)}>{s.dpRefresh}</button>
              {#if notes[`refresh-${t.target}`]}<span class="small" role="alert">{notes[`refresh-${t.target}`]?.text}</span>{/if}
            </div>
          </div>
        </section>
      {/each}
    </div>
  {:else if tab === 'sites'}
    <div class="stack rise" style="gap: 20px">
      <h2 class="h2s">{s.dpSitesH}</h2>
      <div class="tblwrap">
        <table class="tbl">
          <thead><tr><th>{s.dpColAddress}</th><th>{s.dpColTarget}</th><th>{s.dpColStatus}</th></tr></thead>
          <tbody>
            {#each targets as t (t.target)}
              {#each t.domains as dom (dom)}
                <tr><td class="mono">{dom}</td><td>{t.target}</td><td><span class="chip" class:ok={t.status === 'paired'}>{t.status === 'paired' ? s.dpSiteLive : s.dpSiteNotLive}</span></td></tr>
              {/each}
            {/each}
            {#each addresses as a (a.name)}
              <tr><td class="mono">{a.name}</td><td>{a.project}</td><td class="small">{afill(s.dpAddrApproved, { by: a.approvedBy })}</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if addresses.length === 0}<p class="small muted">{s.dpAddrNone}</p>{/if}
      <p class="small muted">{s.dpSitesNote}</p>
    </div>
  {:else if tab === 'releases'}
    <div class="stack rise" style="gap: 24px">
      <h2 class="h2s">{s.dpRelH}</h2>
      {#each pairedTargets as t (t.target)}
        {@const h = details[t.target]?.heartbeat ?? null}
        <div class="tblwrap">
          <table class="tbl">
            <caption class="sr-only">{t.target}</caption>
            <thead><tr><th>{s.dpRelCol}</th><th>{s.dpRelState}</th><th><span class="sr-only">{s.dpRelActivate}</span></th></tr></thead>
            <tbody>
              {#if h}
                {#each releaseRows(h) as n (n)}
                  <tr>
                    <td class="mono">{afill(s.dpReleaseN, { n })}</td>
                    <td><span class="chip" class:ok={n === h.activeRelease}>{releaseState(h, n)}</span></td>
                    <td>{#if n !== h.activeRelease}<button type="button" class="btn" disabled={!!busy} aria-label={afill(s.dpRelActivateFor, { n })} onclick={() => activate(t.target, n)}><Icon name="passkey" small />{s.dpRelActivate}</button>{/if}</td>
                  </tr>
                {/each}
              {/if}
            </tbody>
          </table>
        </div>
        {#if !h || releaseRows(h).length === 0}<p class="small muted">{s.dpRelNone}</p>{/if}
      {/each}
      {#if pairedTargets.length === 0}<p class="small muted">{s.dpRelNone}</p>{/if}
      {#if notes.release}<p class="amsg" class:okmsg={notes.release.ok} role="status">{notes.release.text}</p>{/if}
      <div class="cols3">
        <div class="walllabel"><h3 class="label">{s.dpRelRollbackH}</h3><p class="small">{s.dpRelRollbackText}</p></div>
        <div class="walllabel"><h3 class="label">{s.dpRelBackH}</h3><p class="small">{s.dpRelBackText}</p><p class="small muted">{s.dpRelNumbersText}</p></div>
      </div>
    </div>
  {:else if tab === 'certs'}
    <div class="stack rise" style="gap: 20px">
      <h2 class="h2s">{s.dpCertH}</h2>
      {#if certs.length === 0}<p class="small muted">{s.dpCertNone}</p>{/if}
      <div class="rows">
        {#each certs as c, i (i)}
          <div class="r"><span class="mono" style="flex: 1 1 220px">{c.names.join(', ')}</span><span class="small muted">{c.target}{c.notAfter ? ` · ${afill(s.dpCertUntil, { at: when(c.notAfter) })}` : ''}</span><span class="chip" class:ok={c.status === 'issued'} class:warn={c.status === 'failed'}>{s.dpCertStatus[c.status] ?? c.status}</span></div>
        {/each}
      </div>
      <p class="small muted">{s.dpCertNote}</p>
      <div class="row"><button type="button" class="btn" disabled={busy === 'certs'} onclick={runCerts}>{s.dpCertRun}</button></div>
      {#if notes.certs}<p class="amsg" class:okmsg={notes.certs.ok} role="status">{notes.certs.text}</p>{/if}
    </div>
  {:else}
    <div class="stack rise" style="gap: 16px">
      <p class="muted">{s.dpKillText}</p>
      {#each pairedTargets as t (t.target)}
        {@const d = details[t.target]}
        <div class="cols3" data-testid="kill-{t.target}">
          <section class="card">
            <div class="card-b">
              <Icon name="freeze" />
              <h3 style="font-size: 17px">{s.dpFreezeH}</h3>
              <p class="small muted">{s.dpFreezeText}</p>
              <span class="chip" class:sig={d?.heartbeat?.frozen} data-testid="frozen-state">{!d?.heartbeat ? s.dpFrozenUnknown : d.heartbeat.frozen ? s.dpFrozenNow : s.dpNotFrozenNow}</span>
            </div>
            <div class="card-f"><span class="note">{s.dpFreezeNote}</span><button type="button" class="btn danger" disabled={!!busy} onclick={() => freeze(t.target)}>{s.dpFreeze}</button></div>
          </section>
          <section class="card">
            <div class="card-b"><Icon name="lock" /><h3 style="font-size: 17px">{s.dpUnfreezeH}</h3><p class="small muted">{s.dpUnfreezeText}</p></div>
            <div class="card-f"><span class="note">{s.dpUnfreezeNote}</span><button type="button" class="btn danger" disabled={!!busy} onclick={() => unfreeze(t.target)}><Icon name="passkey" small />{s.dpUnfreeze}</button></div>
          </section>
        </div>
        <div class="row"><button type="button" class="btn" onclick={load}>{s.retry}</button></div>
        <h3 class="label">{s.dpCmdH}</h3>
        {#if !d?.commands.length}<p class="small muted">{s.dpCmdNone}</p>{/if}
        <div class="rows small">
          {#each (d?.commands ?? []).slice(0, 8) as cmd (cmd.id)}
            <div class="r"><b>{s.dpCmdPurpose[cmd.purpose] ?? cmd.purpose}</b><span class="muted">{afill(s.dpCmdNumber, { n: cmd.sequence ?? '' })}</span><span class="chip">{s.dpCmdStatus[cmd.status] ?? cmd.status}</span><span class="mono small muted">{when(cmd.createdAt)}</span></div>
          {/each}
        </div>
      {/each}
      {#if notes.kill}<p class="amsg" class:okmsg={notes.kill.ok} role="status">{notes.kill.text}</p>{/if}
    </div>
  {/if}

  {#snippet bar()}
    <span class="conseq">{s.dpConseq}</span>
    <button type="button" class="btn primary" onclick={() => openWizard()}>{s.dpAdd}</button>
  {/snippet}
</AdminShell>
