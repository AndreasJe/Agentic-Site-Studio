// A tiny file-based queue. A job is { id, packageDir, settings }.
// pending/ -> running/ (rename claims it, first rename wins) -> results/<id>.json
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function openQueue(dir) {
  for (const d of ['pending', 'running', 'results']) mkdirSync(join(dir, d), { recursive: true })
  const p = (...a) => join(dir, ...a)

  function writeAtomic(file, text) {
    const tmp = `${file}.tmp`
    writeFileSync(tmp, text)
    renameSync(tmp, file)
  }

  return {
    dir,
    enqueue(job) {
      writeAtomic(p('pending', `${job.id}.json`), JSON.stringify(job))
    },
    claim() {
      for (const f of readdirSync(p('pending'))
        .filter((n) => n.endsWith('.json'))
        .sort()) {
        try {
          renameSync(p('pending', f), p('running', f))
          return JSON.parse(readFileSync(p('running', f), 'utf8'))
        } catch {}
      }
      return null
    },
    finish(id, result) {
      writeAtomic(p('results', `${id}.json`), JSON.stringify(result, null, 2))
      rmSync(p('running', `${id}.json`), { force: true })
    },
    result(id) {
      try {
        return JSON.parse(readFileSync(p('results', `${id}.json`), 'utf8'))
      } catch {
        return null
      }
    },
  }
}

// Polls the queue; at most `concurrency` (1-2) jobs at once.
export function startWorker({ queue, concurrency = 1, run, pollMs = 100 }) {
  const n = Math.min(2, Math.max(1, concurrency))
  let active = 0
  let stopped = false
  const timer = setInterval(() => {
    while (!stopped && active < n) {
      const job = queue.claim()
      if (!job) return
      active++
      const startedAt = Date.now()
      run(job)
        .catch((e) => ({ id: job.id, error: String(e?.stack ?? e) }))
        .then((result) => queue.finish(job.id, { ...result, startedAt, finishedAt: Date.now() }))
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

export async function waitForResult(queue, id, timeoutMs = 120000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const r = queue.result(id)
    if (r) return r
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`timeout waiting for ${id}`)
}
