// Child process for the kill test: writes 200 kB revision files as fast as it can until killed.
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { writeNew } from '../server/store/atomic.ts'

const dir = join(process.argv[2] ?? '.', 'revisions')
let n = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).length + 1 : 1
const padding = 'x'.repeat(200_000)
// Tell the test we're running, so its kill delay measures writing time, not start-up time.
process.stdout.write('ready')
for (;;) {
  writeNew(join(dir, `r${n}.json`), new TextEncoder().encode(JSON.stringify({ n, padding })))
  n++
}
