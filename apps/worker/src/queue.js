// The job folders (docs/m6-interfaces.md): <dataDir>/checks/{pending,running,results}.
// A job moves pending/<id>.json -> running/<id>.json (a rename claims it; the first rename wins)
// and its result lands in results/<id>.json. Every write is a temp file and then a rename.
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function openQueue(dataDir) {
  const dir = join(dataDir, 'checks')
  for (const d of ['pending', 'running', 'results']) mkdirSync(join(dir, d), { recursive: true })
  const p = (...a) => join(dir, ...a)

  function writeAtomic(file, text) {
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, text)
    renameSync(tmp, file)
  }

  const queue = {
    dir,
    enqueue(job) {
      writeAtomic(p('pending', `${job.id}.json`), JSON.stringify(job))
    },
    // After a crash, jobs left in running/ go back to pending/. Call once at start, with one worker.
    recover() {
      for (const f of readdirSync(p('running')).filter((n) => n.endsWith('.json')))
        renameSync(p('running', f), p('pending', f))
    },
    claim() {
      for (const f of readdirSync(p('pending'))
        .filter((n) => n.endsWith('.json'))
        .sort()) {
        try {
          renameSync(p('pending', f), p('running', f))
        } catch {
          continue // another worker got it
        }
        const id = f.slice(0, -5)
        try {
          return JSON.parse(readFileSync(p('running', f), 'utf8'))
        } catch (e) {
          queue.finish(id, {
            id,
            hashOk: false,
            checks: [],
            blocked: true,
            error: `unreadable job: ${e.message}`,
          })
        }
      }
      return null
    },
    finish(id, result) {
      writeAtomic(p('results', `${id}.json`), JSON.stringify(result, null, 2))
      rmSync(p('running', `${id}.json`), { force: true })
    },
    imagesDir(id) {
      return p('results', `${id}.images`)
    },
    result(id) {
      try {
        return JSON.parse(readFileSync(p('results', `${id}.json`), 'utf8'))
      } catch {
        return null
      }
    },
  }
  return queue
}

// Polls pending/; at most `concurrency` (1-2) jobs at once.
export function startWorker({ queue, concurrency = 1, run, pollMs = 250 }) {
  const n = Math.min(2, Math.max(1, Math.floor(concurrency) || 1))
  let active = 0
  let stopped = false
  const timer = setInterval(() => {
    while (!stopped && active < n) {
      const job = queue.claim()
      if (!job) return
      active++
      const startedAt = new Date().toISOString()
      Promise.resolve()
        .then(() => run(job, { imagesDir: queue.imagesDir(job.id) }))
        .catch((e) => ({
          id: job.id,
          kind: job.kind,
          hash: job.hash,
          hashOk: false,
          checks: [],
          blocked: true,
          error: String(e?.stack ?? e),
        }))
        .then((result) =>
          queue.finish(job.id, { ...result, startedAt, finishedAt: new Date().toISOString() }),
        )
        .finally(() => {
          active--
        })
    }
  }, pollMs)
  return {
    stop() {
      stopped = true
      clearInterval(timer)
    },
  }
}

export async function waitForResult(queue, id, timeoutMs = 180000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const r = queue.result(id)
    if (r) return r
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`timeout waiting for ${id}`)
}
