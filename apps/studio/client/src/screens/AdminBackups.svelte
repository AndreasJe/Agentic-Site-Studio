<script lang="ts">
// Backups (plan §12.2; design/prototype/AdminBackups.dc.html; M8.5). Admin only. Target,
// schedule, scope, retention, run now, the list at the target and restore into a new copy. The
// passphrase is typed, sent once and cleared; it is never shown back.
import AdminShell from '../components/AdminShell.svelte'
import Icon from '../components/Icon.svelte'
import { fmtAt, fmtSize, errText } from '../lib/admin-format.ts'
import { ad, afill } from '../lib/admin-strings.ts'
import { api } from '../lib/api.ts'
import { i18n } from '../lib/i18n.svelte.ts'
import { session } from '../lib/session.svelte.ts'

type Target = { kind: 'folder'; path: string } | { kind: 'rclone'; remote: string }
type Scope = { kind: 'all' } | { kind: 'project'; id: string }
type Last =
  | { ok: true; at: string; name: string; size: number; files: number }
  | { ok: false; at: string; error: string }
type Backup = { name: string; size: number; modified: string }
type Data = {
  target: Target | null
  needsRclone: boolean
  scope: Scope
  schedule: { intervalHours?: number; keepLast?: number; keepDays?: number; lastRun: string | null }
  lastResult: Last | null
  timerHasPassphrase: boolean
  backups: Backup[]
}
type Msg = { text: string; ok: boolean } | null

const s = $derived(ad())
const isAdmin = $derived(session.user?.role === 'admin')

let view = $state<'loading' | 'ok' | 'failed'>('loading')
let data = $state<Data | null>(null)
let projects = $state<{ id: string; name: string }[]>([])

let kind = $state<'folder' | 'rclone'>('folder')
let path = $state('')
let remote = $state('')
let interval = $state('0')
let scopeKind = $state<'all' | 'project'>('all')
let scopeProject = $state('')
let keepLast = $state('0')
let keepDays = $state('0')

let passphrase = $state('')
let running = $state(false)
let settingsMsg = $state<Msg>(null)
let runMsg = $state<Msg>(null)

let rName = $state('')
let rPass = $state('')
let rDest = $state('')
let restoring = $state(false)
let restoreMsg = $state<Msg>(null)

function fill(d: Data) {
  data = d
  kind = d.target?.kind ?? 'folder'
  path = d.target?.kind === 'folder' ? d.target.path : ''
  remote = d.target?.kind === 'rclone' ? d.target.remote : ''
  interval = String(d.schedule.intervalHours ?? 0)
  scopeKind = d.scope.kind
  scopeProject = d.scope.kind === 'project' ? d.scope.id : (projects[0]?.id ?? '')
  keepLast = String(d.schedule.keepLast ?? 0)
  keepDays = String(d.schedule.keepDays ?? 0)
}

async function load() {
  const [b, p] = await Promise.all([
    api<Data>('GET', '/api/admin/backups'),
    api<{ projects: { id: string; name: string }[] }>('GET', '/api/projects'),
  ])
  if (!b.ok) {
    view = 'failed'
    return
  }
  projects = p.body.projects ?? []
  fill(b.body)
  view = 'ok'
}

$effect(() => {
  if (isAdmin) load()
})

const whole = (v: string) => (/^\d{1,6}$/.test(v.trim()) ? Number(v) : Number.NaN)

function settingsBody() {
  return {
    target: kind === 'folder' ? { kind, path: path.trim() } : { kind, remote: remote.trim() },
    scope: scopeKind === 'all' ? { kind: 'all' } : { kind: 'project', id: scopeProject },
    intervalHours: whole(interval),
    keepLast: whole(keepLast),
    keepDays: whole(keepDays),
  }
}

async function saveSettings(): Promise<boolean> {
  settingsMsg = null
  const b = settingsBody()
  if ([b.intervalHours, b.keepLast, b.keepDays].some(Number.isNaN)) {
    settingsMsg = { text: s.bkCode['bad-settings'] ?? '', ok: false }
    return false
  }
  const r = await api<{ code?: string }>('PUT', '/api/admin/backups/settings', b)
  if (!r.ok) {
    settingsMsg = { text: errText(r.body.code, s.bkCode), ok: false }
    return false
  }
  settingsMsg = { text: s.bkSettingsSaved, ok: true }
  const again = await api<Data>('GET', '/api/admin/backups')
  if (again.ok) fill(again.body)
  return true
}

async function run() {
  if (running) return
  runMsg = null
  if (!passphrase) {
    runMsg = { text: s.bkNeedPass, ok: false }
    return
  }
  running = true
  if (await saveSettings()) {
    const r = await api<{ result?: { name: string; files: number }; code?: string }>(
      'POST',
      '/api/admin/backups/run',
      { passphrase },
    )
    passphrase = ''
    runMsg = r.ok
      ? { text: afill(s.bkRunDone, { name: r.body.result?.name ?? '', files: r.body.result?.files ?? 0 }), ok: true }
      : { text: errText(r.body.code, s.bkCode), ok: false }
    const again = await api<Data>('GET', '/api/admin/backups')
    if (again.ok) data = again.body
  }
  running = false
}

async function restore() {
  if (restoring) return
  restoreMsg = null
  restoring = true
  const r = await api<{ result?: { dir: string; files: number }; code?: string }>(
    'POST',
    '/api/admin/backups/restore',
    { name: rName, passphrase: rPass, destDir: rDest.trim() },
  )
  rPass = ''
  restoring = false
  restoreMsg = r.ok
    ? { text: afill(s.bkRestoreDone, { files: r.body.result?.files ?? 0, dir: r.body.result?.dir ?? '' }), ok: true }
    : { text: errText(r.body.code, s.bkCode), ok: false }
}

function pickForRestore(name: string) {
  rName = name
  document.getElementById('bk-restore-h')?.scrollIntoView({ block: 'start' })
}

const last = $derived(data?.lastResult ?? null)
const lastText = $derived(
  !last
    ? s.bkNoRun
    : last.ok
      ? afill(s.bkLastOk, { name: last.name, size: fmtSize(last.size), files: last.files, at: fmtAt(last.at, i18n.lang) })
      : afill(s.bkLastFailed, { at: fmtAt(last.at, i18n.lang), error: last.error }),
)
</script>

<AdminShell
  heading={s.bkHeading}
  kicker={s.kicker}
  sub={s.bkSub}
  active="backups"
  did={s.bkDid}
  state={view}
>
  {#if data}
    <section class="sec" aria-labelledby="bk-st">
      <div class="sec-h"><h2 id="bk-st" class="h2s">{s.bkStatusH}</h2><span class="m8-sub">{s.bkFailNote}</span></div>
      <p class="m8-last" class:ok={last?.ok === true} class:bad={last?.ok === false} data-testid="bk-last">{lastText}</p>
      <p class="small muted">{data.timerHasPassphrase ? s.bkTimerOn : s.bkTimerOff}</p>
    </section>

    <section class="sec" aria-labelledby="bk-tg">
      <div class="sec-h"><h2 id="bk-tg" class="h2s">{s.bkTargetH}</h2><span class="m8-sub">{s.bkTargetSub}</span></div>
      <div class="m8-pick" role="group" aria-label={s.bkTargetAria}>
        <button type="button" class="choice" aria-pressed={kind === 'folder'} onclick={() => (kind = 'folder')}>
          <b>{s.bkTargetFolder}</b><span class="small muted">{s.bkTargetFolderNote}</span>
        </button>
        <button type="button" class="choice" aria-pressed={kind === 'rclone'} onclick={() => (kind = 'rclone')}>
          <b>{s.bkTargetRclone}</b><span class="small muted">{s.bkTargetRcloneNote}</span>
        </button>
      </div>
      {#if kind === 'folder'}
        <div class="field">
          <label for="bk-path">{s.bkPath}</label>
          <input id="bk-path" class="input mono" bind:value={path} autocomplete="off" aria-describedby="bk-path-h" />
          <span id="bk-path-h" class="m8-sub">{s.bkPathHelp}</span>
        </div>
      {:else}
        <div class="field">
          <label for="bk-remote">{s.bkRemote}</label>
          <input id="bk-remote" class="input mono" bind:value={remote} autocomplete="off" aria-describedby="bk-remote-h" />
          <span id="bk-remote-h" class="m8-sub">{s.bkRemoteHelp}</span>
        </div>
      {/if}
      {#if data.needsRclone}
        <p class="amsg" role="status" data-testid="bk-needs-rclone"><b>{s.bkNeedsRclone}</b> · {s.bkNeedsRcloneText}</p>
      {/if}
    </section>

    <section class="sec" aria-labelledby="bk-sc">
      <div class="sec-h"><h2 id="bk-sc" class="h2s">{s.bkScheduleH}</h2></div>
      <div class="fgrid">
        <div class="field">
          <label for="bk-int">{s.bkInterval}</label>
          <input id="bk-int" class="input mono" inputmode="numeric" bind:value={interval} aria-describedby="bk-int-h" />
          <span id="bk-int-h" class="m8-sub">{s.bkIntervalHelp}</span>
        </div>
        <div class="field">
          <label for="bk-scope">{s.bkScope}</label>
          <select id="bk-scope" class="input" bind:value={scopeKind}>
            <option value="all">{s.bkScopeAll}</option>
            <option value="project">{s.bkScopeProject}</option>
          </select>
        </div>
        {#if scopeKind === 'project'}
          <div class="field">
            <label for="bk-proj">{s.bkProject}</label>
            <select id="bk-proj" class="input" bind:value={scopeProject}>
              {#each projects as p (p.id)}<option value={p.id}>{p.name} · {p.id}</option>{/each}
            </select>
          </div>
        {/if}
      </div>
    </section>

    <section class="sec" aria-labelledby="bk-rt">
      <div class="sec-h"><h2 id="bk-rt" class="h2s">{s.bkRetentionH}</h2><span class="m8-sub">{s.bkRetentionNote}</span></div>
      <div class="fgrid">
        <div class="field">
          <label for="bk-kl">{s.bkKeepLast}</label>
          <input id="bk-kl" class="input mono" inputmode="numeric" bind:value={keepLast} aria-describedby="bk-kh" />
        </div>
        <div class="field">
          <label for="bk-kd">{s.bkKeepDays}</label>
          <input id="bk-kd" class="input mono" inputmode="numeric" bind:value={keepDays} aria-describedby="bk-kh" />
        </div>
      </div>
      <span id="bk-kh" class="m8-sub">{s.bkKeepHelp}</span>
      <div class="row">
        <button type="button" class="btn" onclick={saveSettings}>{s.bkSaveSettings}</button>
        <span class="m8-sub">{s.bkSettingsConseq}</span>
      </div>
      {#if settingsMsg}<p class="amsg" class:okmsg={settingsMsg.ok} role={settingsMsg.ok ? 'status' : 'alert'}>{settingsMsg.text}</p>{/if}
    </section>

    <section class="sec" aria-labelledby="bk-pw">
      <div class="sec-h"><h2 id="bk-pw" class="h2s">{s.bkPassH}</h2></div>
      <div class="field" style="max-width: 420px">
        <label for="bk-pass">{s.bkPass}</label>
        <input id="bk-pass" class="input" type="password" bind:value={passphrase} autocomplete="new-password" aria-describedby="bk-pass-h" />
        <span id="bk-pass-h" class="m8-sub">{s.bkPassHelp}</span>
      </div>
      {#if runMsg}<p class="amsg" class:okmsg={runMsg.ok} role={runMsg.ok ? 'status' : 'alert'} data-testid="bk-run-msg">{runMsg.text}</p>{/if}
    </section>

    <section class="sec" aria-labelledby="bk-ls">
      <div class="sec-h"><h2 id="bk-ls" class="h2s">{s.bkListH}</h2></div>
      {#if data.backups.length === 0}
        <p class="small muted">{s.bkListEmpty}</p>
      {:else}
        <div class="tblwrap">
          <table class="tbl" data-testid="bk-list">
            <thead><tr><th scope="col">{s.bkColName}</th><th scope="col">{s.bkColSize}</th><th scope="col">{s.bkColAt}</th><th scope="col"><span class="sr-only">{s.bkRestoreRow}</span></th></tr></thead>
            <tbody>
              {#each data.backups as b (b.name)}
                <tr>
                  <td class="mono small">{b.name}</td>
                  <td class="mono small m8-nowrap">{fmtSize(b.size)}</td>
                  <td class="mono small">{fmtAt(b.modified, i18n.lang)}</td>
                  <td><button type="button" class="btn quiet" aria-label={afill(s.bkRestoreRowAria, { name: b.name })} onclick={() => pickForRestore(b.name)}>{s.bkRestoreRow}</button></td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </section>

    <section class="card ink" aria-labelledby="bk-restore-h">
      <div class="card-h"><Icon name="backup" /><h2 id="bk-restore-h" class="h2s" style="font-size: 22px">{s.bkRestoreH}</h2></div>
      <div class="card-b">
        <p class="small muted">{s.bkRestoreSub}</p>
        <div class="fgrid">
          <div class="field">
            <label for="bk-rn">{s.bkRestoreName}</label>
            <select id="bk-rn" class="input mono" bind:value={rName}>
              <option value="">{s.bkRestorePick}</option>
              {#each data.backups as b (b.name)}<option value={b.name}>{b.name}</option>{/each}
            </select>
          </div>
          <div class="field">
            <label for="bk-rp">{s.bkRestorePass}</label>
            <input id="bk-rp" class="input" type="password" bind:value={rPass} autocomplete="off" />
          </div>
          <div class="field">
            <label for="bk-rd">{s.bkRestoreDest}</label>
            <input id="bk-rd" class="input mono" bind:value={rDest} autocomplete="off" aria-describedby="bk-rd-h" />
            <span id="bk-rd-h" class="m8-sub">{s.bkRestoreDestHelp}</span>
          </div>
        </div>
        {#if restoreMsg}<p class="amsg" class:okmsg={restoreMsg.ok} role={restoreMsg.ok ? 'status' : 'alert'}>{restoreMsg.text}</p>{/if}
      </div>
      <div class="card-f">
        <span class="note">{s.bkRestoreConseq}</span>
        <button type="button" class="btn" disabled={restoring || !rName || !rPass || !rDest.trim()} onclick={restore}>{s.bkRestoreGo}</button>
      </div>
    </section>
  {/if}

  {#snippet bar()}
    <span class="conseq">{s.bkConseq}</span>
    <button type="button" class="btn primary" disabled={running} onclick={run}>{running ? s.bkRunning : s.bkRun}</button>
  {/snippet}
</AdminShell>
