// Generated code gone bad. Each attempt records what happened; CSP violations are collected
// through a securitypolicyviolation listener. Targets come from the query string (spike only).
const params = new URLSearchParams(location.search)
const app = params.get('app') ?? ''
const lan = params.get('lan') ?? ''
const violations = []
document.addEventListener('securitypolicyviolation', (e) =>
  violations.push({ directive: e.effectiveDirective, blocked: e.blockedURI }),
)

const within = (ms, promise) =>
  Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve('timeout'), ms))])
const attempt = (fn) =>
  within(
    5000,
    Promise.resolve()
      .then(fn)
      .then(
        (v) => v,
        (e) => `error: ${e.name}`,
      ),
  )
const image = (src) =>
  new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve('loaded')
    img.onerror = () => resolve('error')
    img.src = src
  })
const socket = (url) =>
  new Promise((resolve) => {
    const ws = new WebSocket(url)
    ws.onopen = () => {
      resolve('open')
      ws.close()
    }
    ws.onerror = () => resolve('error')
  })

async function run() {
  const results = {}
  results.cookie = document.cookie

  results.fetchPost = await attempt(async () => {
    const res = await fetch(`${app}/api/approve`, {
      method: 'POST',
      mode: 'no-cors',
      credentials: 'include',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ rev: 'rev-attack', section: 'hero' }),
    })
    return `response: ${res.type} ${res.status}`
  })
  results.fetchGet = await attempt(async () => {
    const res = await fetch(`${app}/api/revision?rev=rev-attack`, { credentials: 'include' })
    return `read: ${await res.text()}`
  })
  results.imageBeacon = await attempt(() => image(`${app}/api/revision?rev=rev-attack&beacon=1`))

  results.formPost = await attempt(() => {
    const sink = document.createElement('iframe')
    sink.name = 'sink'
    document.body.append(sink)
    const form = document.createElement('form')
    form.method = 'post'
    form.action = `${app}/api/approve`
    form.target = 'sink'
    const field = document.createElement('input')
    field.name = 'section'
    field.value = 'hero'
    form.append(field)
    document.body.append(form)
    form.submit()
    return 'submitted'
  })

  results.frameApp = await attempt(() => {
    const frame = document.createElement('iframe')
    frame.id = 'app-frame'
    frame.src = `${app}/review/rev-attack`
    document.body.append(frame)
    return new Promise((resolve) => {
      frame.onload = () => {
        try {
          resolve(`read: ${frame.contentDocument?.title ?? 'no document'}`)
        } catch (e) {
          resolve(`loaded, unreadable: ${e.name}`)
        }
      }
    })
  })

  results.webauthn = await attempt(async () => {
    const challenge = crypto.getRandomValues(new Uint8Array(32))
    await navigator.credentials.get({ publicKey: { rpId: 'localhost', challenge } })
    return 'accepted'
  })

  results.lanFetch = await attempt(async () => {
    const res = await fetch(`${lan}/fetch`, { mode: 'no-cors' })
    return `response: ${res.type}`
  })
  results.lanImage = await attempt(() => image(`${lan}/image`))
  results.lanSocket = await attempt(() => socket(`${lan.replace(/^http/, 'ws')}/ws`))

  // Spoofed messages to the app (top) and to the shell (parent).
  for (const target of new Set([window.top, window.parent])) {
    target.postMessage({ type: 'section-click', id: 'hero' }, '*')
    target.postMessage({ type: 'section-click', id: 'not-a-section' }, '*')
    target.postMessage({ type: 'approve', id: 'hero' }, '*')
  }
  results.messages = 'posted'

  await new Promise((resolve) => setTimeout(resolve, 500)) // let violation events arrive
  results.violations = violations
  document.getElementById('results').textContent = JSON.stringify(results)
  document.body.dataset.done = '1'
}

run()
