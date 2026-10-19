<script lang="ts">
import DecisionBar from '../components/DecisionBar.svelte'
import Icon from '../components/Icon.svelte'
import LangSwitch from '../components/LangSwitch.svelte'
import { api, setCsrf } from '../lib/api.ts'
import { type Key, t } from '../lib/i18n.svelte.ts'
import { type PasskeyResult, setUpPasskey, signInWithPasskey } from '../lib/passkey.ts'
import { afterSignIn } from '../lib/session.svelte.ts'

let handle = $state('')
let password = $state('')
let setupHandle = $state('')
let setupCode = $state('')
let error = $state<string | null>(null)
let waiting = $state(false)
let busy = $state(false)

const message = (code: string): string => {
  const key = `si.err.${code}` as Key
  try {
    return t(key)
  } catch {
    return t('si.err.other')
  }
}

async function creatorSignIn(e: SubmitEvent) {
  e.preventDefault()
  error = null
  busy = true
  const res = await api<{ csrf?: string; code?: string }>('POST', '/api/sign-in', {
    handle,
    password,
  })
  busy = false
  if (res.ok && res.body.csrf) {
    setCsrf(res.body.csrf)
    await afterSignIn()
  } else error = message(res.body.code ?? 'other')
}

async function passkey(run: () => Promise<PasskeyResult>) {
  error = null
  waiting = true
  const result = await run()
  waiting = false
  if (result.ok) await afterSignIn()
  else error = message(result.code)
}
</script>

<div class="app">
  <header class="top">
    <span class="brand"
      ><svg class="ic" viewBox="0 0 20 20" aria-hidden="true"><use href="/icons.svg#ic-brand-mark" /></svg
      >Site Studio</span
    >
    <div class="top-r"><LangSwitch /></div>
  </header>

  <main class="main" style="max-width: 1120px; padding-top: 56px; gap: 40px">
    <div class="stack" style="gap: 10px">
      <h1 class="serif hero-title">Site Studio</h1>
      <p class="muted" style="font-size: 18px; max-width: 640px">{t('si.tagline')}</p>
      <span class="row small muted"
        ><span class="mono">studio.internal</span><span>· {t('si.internalNet')}</span></span
      >
    </div>

    {#if error}
      <p class="chip warn rise" role="alert" style="align-self: flex-start">{error}</p>
    {/if}

    <div class="door">
      <section class="card" aria-labelledby="c-h">
        <div class="card-h"><Icon name="design" /><h2 id="c-h" class="h2s">{t('si.cTitle')}</h2></div>
        <form id="creator-form" class="card-b" onsubmit={creatorSignIn}>
          <p class="small muted">{t('si.cBody')}</p>
          <div class="field">
            <label for="user">{t('si.user')}</label>
            <input
              id="user"
              class="input"
              type="text"
              autocomplete="username"
              autocapitalize="none"
              bind:value={handle}
            />
          </div>
          <div class="field">
            <label for="pw">{t('si.pw')}</label>
            <input
              id="pw"
              class="input"
              type="password"
              autocomplete="current-password"
              bind:value={password}
            />
          </div>
          <p class="row small"><span class="chip warn">{t('si.concept')}</span></p>
        </form>
        <div class="card-f"><span class="note">{t('si.cNote')}</span></div>
      </section>

      <section class="card ink" aria-labelledby="a-h">
        <div class="card-h"><Icon name="passkey" /><h2 id="a-h" class="h2s">{t('si.aTitle')}</h2></div>
        <div class="card-b">
          <p class="small muted">{t('si.aBody')}</p>
          <div class="rows small">
            {#each ['si.a1', 'si.a2', 'si.a3'] as const as key (key)}
              <div class="r"><Icon name="check" small /><span>{t(key)}</span></div>
            {/each}
          </div>
          {#if waiting}
            <p class="chip rise" role="status">{t('si.pkWaiting')}</p>
          {/if}
          <details>
            <summary class="small" style="min-height: 44px; display: flex; align-items: center; cursor: pointer"
              ><b>{t('si.setupTitle')}</b></summary
            >
            <form
              class="stack"
              style="gap: 12px; padding-top: 8px"
              onsubmit={(e) => {
                e.preventDefault()
                passkey(() => setUpPasskey(setupHandle.trim(), setupCode.trim()))
              }}
            >
              <p class="small muted">{t('si.setupBody')}</p>
              <div class="field">
                <label for="sh">{t('si.handle')}</label>
                <input
                  id="sh"
                  class="input"
                  type="text"
                  autocomplete="username"
                  autocapitalize="none"
                  bind:value={setupHandle}
                />
              </div>
              <div class="field">
                <label for="sc">{t('si.code')}</label>
                <input
                  id="sc"
                  class="input mono"
                  type="text"
                  autocomplete="one-time-code"
                  autocapitalize="none"
                  bind:value={setupCode}
                />
              </div>
              <button class="btn" type="submit" disabled={waiting || !setupHandle || !setupCode}
                ><Icon name="passkey" small />{t('si.setupBtn')}</button
              >
            </form>
          </details>
        </div>
        <div class="card-f">
          <span class="note">{t('si.aNote')}</span>
          <button class="btn" type="button" disabled={waiting} onclick={() => passkey(signInWithPasskey)}
            ><Icon name="passkey" small />{t('si.pkBtn')}</button
          >
        </div>
      </section>
    </div>

    <p class="small muted" style="max-width: 760px">{t('si.footer')}</p>
  </main>

  <DecisionBar did={t('si.decideDid')}>
    <span class="conseq">{t('si.decideCreator')}</span>
    <button class="btn primary" type="submit" form="creator-form" disabled={busy}
      >{t('si.signInCreator')}</button
    >
  </DecisionBar>
</div>
