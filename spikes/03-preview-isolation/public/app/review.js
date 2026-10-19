// The app's review page. Section list, hash and approvals come from the app's own API. The shell
// on the preview origin only sends section clicks, which can change the selection and nothing else.
import { validateMessage } from '/message.js'

const $ = (id) => document.getElementById(id)
const rev = location.pathname.split('/')[2] ?? ''
let csrf = null
let previewOrigin = null
let shell = null
let selected = null
let sections = new Set()
const counts = { accepted: 0, rejected: 0, reasons: [] }

window.addEventListener('message', (event) => {
  const verdict = validateMessage(
    { origin: event.origin, source: event.source, data: event.data },
    { previewOrigin, shell: shell?.contentWindow ?? null, sections },
  )
  if (verdict.ok) {
    counts.accepted++
    select(verdict.id)
  } else {
    counts.rejected++
    counts.reasons.push(verdict.reason)
  }
  const m = $('messages')
  m.dataset.accepted = String(counts.accepted)
  m.dataset.rejected = String(counts.rejected)
  m.textContent = `Messages: ${counts.accepted} accepted, ${counts.rejected} rejected (${counts.reasons.join(', ')})`
})

function select(id) {
  selected = id
  $('selected').textContent = id
  for (const li of $('sections').children)
    li.classList.toggle('selected', li.dataset.section === id)
  $('approve').disabled = false
}

function showApproved(list) {
  $('approved').textContent = list.length ? list.join(', ') : 'none'
}

async function load() {
  const res = await fetch(`/api/revision?rev=${encodeURIComponent(rev)}`)
  if (!res.ok) return
  const view = await res.json()
  previewOrigin = view.previewOrigin
  sections = new Set(view.sections)
  $('hash').textContent = view.hash
  $('sections').replaceChildren(
    ...view.sections.map((id) => {
      const li = document.createElement('li')
      li.dataset.section = id
      li.textContent = id
      return li
    }),
  )
  showApproved(view.approved)
  shell = document.createElement('iframe')
  shell.id = 'shell'
  shell.title = 'Review shell'
  shell.src = `${previewOrigin}/__review/${rev}/${location.search}`
  $('frame').append(shell)
  document.body.dataset.ready = '1'
}

$('approve').addEventListener('click', async () => {
  if (!selected) return
  const res = await fetch('/api/approve', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
    body: JSON.stringify({ rev, section: selected }),
  })
  if (res.ok) showApproved((await res.json()).approved)
})

$('sign-in').addEventListener('click', async () => {
  const res = await fetch('/api/sign-in', { method: 'POST' })
  if (!res.ok) return
  csrf = (await res.json()).csrf
  $('sign-in').hidden = true
  await load()
})

const session = await fetch('/api/session')
if (session.ok) {
  csrf = (await session.json()).csrf
  await load()
} else {
  $('sign-in').hidden = false
}
