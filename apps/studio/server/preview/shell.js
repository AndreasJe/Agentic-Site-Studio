// The editor's review shell (decision #8), served from the preview site, never the app's.
// It frames the artboard unchanged (rule 7), reads where each data-section sits and tells
// the app, which draws the labels itself. Generated code shares this origin and could send
// its own messages: an accepted risk, because labels are only a picture. Approval uses the
// app's own data.
const app = document.documentElement.dataset.app
const frame = document.getElementById('page')

function send() {
  const doc = frame.contentDocument
  if (!doc?.documentElement) return
  const win = doc.defaultView
  const boxes = [...doc.querySelectorAll('[data-section]')].map((el) => {
    const r = el.getBoundingClientRect()
    return {
      id: el.getAttribute('data-section'),
      x: r.left + win.scrollX,
      y: r.top + win.scrollY,
      w: r.width,
      h: r.height,
    }
  })
  const height = doc.documentElement.scrollHeight
  frame.style.height = `${height}px`
  parent.postMessage({ type: 'ss-sections', boxes, height }, app)
}

frame.addEventListener('load', () => {
  send()
  const doc = frame.contentDocument
  if (doc?.documentElement) new ResizeObserver(send).observe(doc.documentElement)
})
