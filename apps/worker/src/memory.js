// Rough RSS sampling: this process plus msedge processes that appeared after launch.
// Windows working set via tasklist (async, so it never starves the event loop); informational
// only, real sizing is on the VM.
import { execFile } from 'node:child_process'

export function edgeProcesses() {
  return new Promise((resolve) => {
    execFile(
      'tasklist',
      ['/FI', 'IMAGENAME eq msedge.exe', '/FO', 'CSV', '/NH'],
      { encoding: 'utf8', timeout: 5000 },
      (err, out) => {
        const map = new Map()
        if (!err)
          for (const line of out.split(/\r?\n/)) {
            const c = line.match(/"([^"]*)"/g)?.map((s) => s.slice(1, -1))
            if (c && c[0] === 'msedge.exe')
              map.set(c[1], Number((c[4] ?? '0').replace(/[^\d]/g, '')) * 1024)
          }
        resolve(map)
      },
    )
  })
}

export function sampler(beforePids) {
  const peak = { worker: 0, browser: 0 }
  let busy = false
  return {
    async sample() {
      if (busy) return
      busy = true
      peak.worker = Math.max(peak.worker, process.memoryUsage().rss)
      let b = 0
      for (const [pid, bytes] of await edgeProcesses()) if (!beforePids.has(pid)) b += bytes
      peak.browser = Math.max(peak.browser, b)
      busy = false
    },
    peak,
  }
}
