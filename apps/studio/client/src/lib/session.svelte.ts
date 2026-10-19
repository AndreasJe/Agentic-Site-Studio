import { api, setCsrf } from './api.ts'
import { adoptLanguage } from './i18n.svelte.ts'
import { navigate } from './router.svelte.ts'

export type User = {
  id: number
  handle: string
  name: string
  role: 'admin' | 'creator'
  language: 'en' | 'da'
}

export const session = $state<{ ready: boolean; user: User | null }>({ ready: false, user: null })

/** Asks /api/me who is signed in (cookie) and picks up the CSRF token and language. */
export async function loadSession() {
  const res = await api<{ user?: User; csrf?: string }>('GET', '/api/me')
  if (res.ok && res.body.user && res.body.csrf) {
    setCsrf(res.body.csrf)
    session.user = res.body.user
    adoptLanguage(res.body.user.language)
  } else {
    session.user = null
  }
  session.ready = true
}

/** After sign-in or passkey setup (the reply already set the CSRF token). */
export async function afterSignIn() {
  await loadSession()
  navigate('/projects')
}

export async function signOut() {
  await api('POST', '/api/sign-out')
  setCsrf('')
  session.user = null
  navigate('/sign-in')
}
