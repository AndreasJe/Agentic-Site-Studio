// node src/main.js <queueDir> [concurrency 1-2]
import { openQueue, startWorker } from './queue.js'
import { runJob } from './run.js'

const [dir, c] = process.argv.slice(2)
if (!dir) throw new Error('usage: node src/main.js <queueDir> [concurrency 1-2]')
startWorker({ queue: openQueue(dir), concurrency: Number(c ?? 1), run: runJob })
console.log(`check runner watching ${dir}`)
