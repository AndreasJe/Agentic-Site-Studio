// The review shell (decisions #8, #46), served from the preview site, never the app's. It frames
// the revision's package unchanged (rule 7) and tells the app three things: where each
// data-section sits, which page is showing, and what axe finds. Anything it sends is
// package-controlled as far as the app is concerned: the app only changes its selection from it
// and never approves or ticks from it. Approval uses the app's own data.
const app = document.documentElement.dataset.app
const frame = document.getElementById('page')
const base = location.pathname.replace(/^\/__review\//, '/r/')

// The app may ask for a page through the hash. Only package-style paths are followed, built
// here from an allow-list, never passed through (spike 3 must-do 5).
function wanted() {
  // Segments start with a letter or digit, so "." and ".." never match; dots inside are fine
  // (folders named after a further address, review of M5).
  const m = /^#page=((?:[a-z0-9][a-z0-9.-]*\/)*)index\.html$/.exec(location.hash)
  return m ? `${m[1]}index.html` : 'index.html'
}
frame.src = base + wanted()
addEventListener('hashchange', () => {
  frame.src = base + wanted()
})

const pageOf = () => {
  const path = frame.contentWindow?.location.pathname ?? ''
  return path.startsWith(base) ? path.slice(base.length) : ''
}

function boxes(doc) {
  const win = doc.defaultView
  return [...doc.querySelectorAll('[data-section]')].slice(0, 200).map((el) => {
    const r = el.getBoundingClientRect()
    return {
      id: el.getAttribute('data-section'),
      x: r.left + win.scrollX,
      y: r.top + win.scrollY,
      w: r.width,
      h: r.height,
    }
  })
}

function send(findings) {
  const doc = frame.contentDocument
  if (!doc?.documentElement) return
  const height = doc.documentElement.scrollHeight
  frame.style.height = `${height}px`
  const msg = { type: 'ss-review', page: pageOf(), boxes: boxes(doc), height }
  if (findings) msg.findings = findings
  parent.postMessage(msg, app)
}

async function audit() {
  const doc = frame.contentDocument
  if (!doc?.documentElement || !window.axe) return
  try {
    const result = await window.axe.run(doc.documentElement, { resultTypes: ['violations'] })
    const findings = result.violations.slice(0, 100).map((v) => ({
      rule: v.id,
      impact: v.impact ?? null,
      help: v.help,
      targets: v.nodes.slice(0, 20).map((n) => String(n.target?.[0] ?? '')),
    }))
    send(findings)
  } catch {
    send([])
  }
}

frame.addEventListener('load', () => {
  send()
  audit()
  const doc = frame.contentDocument
  if (doc?.documentElement) new ResizeObserver(() => send()).observe(doc.documentElement)
})
