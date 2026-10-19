// Spike 1 client. `?uv=preferred` lowers the browser-side request so tests can prove the server
// still refuses an assertion without user verification.
const $ = (id) => document.getElementById(id)
const uv = new URLSearchParams(location.search).get('uv') ?? 'required'

const enc = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
const dec = (s) =>
  Uint8Array.from(
    atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)),
    (c) => c.charCodeAt(0),
  )

const show = (text) => {
  $('status').textContent = text
}

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json()
}

async function register() {
  show('Waiting for your passkey…')
  const options = await post('/api/register/options', { name: $('name').value })
  if (!options.publicKey) return show(`Refused · ${options.code}`)
  const { challengeId, publicKey } = options
  publicKey.challenge = dec(publicKey.challenge)
  publicKey.user.id = dec(publicKey.user.id)
  publicKey.authenticatorSelection.userVerification = uv
  const cred = await navigator.credentials.create({ publicKey })
  const result = await post('/api/register', {
    challengeId,
    label: $('label').value.trim(),
    response: {
      attestationObject: enc(cred.response.attestationObject),
      clientDataJSON: enc(cred.response.clientDataJSON),
    },
  })
  show(
    result.ok
      ? `Registered · alg ${result.alg} · ${result.backupEligible ? 'synced passkey' : 'device-bound'}`
      : `Refused · ${result.code}`,
  )
}

async function signIn() {
  show('Waiting for your passkey…')
  const options = await post('/api/sign-in/options', {})
  if (!options.publicKey) return show(`Refused · ${options.code}`)
  const { challengeId, publicKey } = options
  publicKey.challenge = dec(publicKey.challenge)
  publicKey.allowCredentials = publicKey.allowCredentials.map((c) => ({ ...c, id: dec(c.id) }))
  publicKey.userVerification = uv
  const cred = await navigator.credentials.get({ publicKey })
  const result = await post('/api/sign-in', {
    challengeId,
    label: $('label').value.trim(),
    rawId: enc(cred.rawId),
    response: {
      authenticatorData: enc(cred.response.authenticatorData),
      clientDataJSON: enc(cred.response.clientDataJSON),
      signature: enc(cred.response.signature),
    },
  })
  show(
    result.ok
      ? `Signed in as ${result.name} · counter ${result.signCount}${result.backedUp ? ' · synced' : ''}`
      : `Refused · ${result.code}`,
  )
}

const guard = (fn) => () => fn().catch((err) => show(`Browser refused · ${err.name}`))
$('register').addEventListener('click', guard(register))
$('sign-in').addEventListener('click', guard(signIn))
