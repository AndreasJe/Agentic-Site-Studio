// Blocks the main thread in many separate tasks, so Total Blocking Time is large.
let n = 0
function burn() {
  const end = performance.now() + 400
  while (performance.now() < end) n += Math.sqrt(n + 1)
  if (++window.__rounds < 12) setTimeout(burn, 0)
}
window.__rounds = 0
burn()
