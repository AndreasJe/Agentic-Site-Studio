// The check runner worker. Watches <dataDir>/checks/pending and writes results.
//   node src/main.js --data <dir>        concurrency from WORKER_CONCURRENCY (1-2, default 1)
import { openQueue, startWorker } from './queue.js'
import { runJob } from './run.js'

const args = process.argv.slice(2)
const at = args.indexOf('--data')
const dataDir = at >= 0 ? args[at + 1] : undefined
if (!dataDir) {
  console.error('usage: node src/main.js --data <dir>')
  process.exit(2)
}
const concurrency = Math.min(2, Math.max(1, Number(process.env.WORKER_CONCURRENCY ?? 1) || 1))
const queue = openQueue(dataDir)
queue.recover()
startWorker({ queue, concurrency, run: runJob })
console.log(`check runner watching ${queue.dir} (concurrency ${concurrency})`)
