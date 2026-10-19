// The review shell, on the preview origin. Frames the package same-origin, draws an overlay for
// every [data-section] element, and posts clicks to the app. It adds nothing to the package.
const appOrigin = document.querySelector('meta[name="app-origin"]').content
const site = document.getElementById('site')
const layer = document.getElementById('overlays')

function draw() {
  const doc = site.contentDocument
  if (!doc) return
  layer.replaceChildren(
    ...[...doc.querySelectorAll('[data-section]')].map((el) => {
      const id = el.dataset.section
      const r = el.getBoundingClientRect()
      const box = document.createElement('button')
      box.type = 'button'
      box.className = 'overlay'
      box.dataset.overlay = id
      box.setAttribute('aria-label', `Select section ${id}`)
      Object.assign(box.style, {
        left: `${r.left}px`,
        top: `${r.top}px`,
        width: `${r.width}px`,
        height: `${r.height}px`,
      })
      box.addEventListener('click', () =>
        parent.postMessage({ type: 'section-click', id }, appOrigin),
      )
      return box
    }),
  )
}

site.addEventListener('load', () => {
  draw()
  site.contentWindow?.addEventListener('scroll', draw)
  site.contentWindow?.addEventListener('resize', draw)
  document.body.dataset.ready = '1'
})
site.src = site.dataset.src + location.search
