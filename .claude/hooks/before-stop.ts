// Stop: when code changed, run lint and the whole test suite; block the stop once if either fails.
import { isCode, readHookInput, run, tail } from './lib.ts'

const input = await readHookInput()
// A second stop in a row means the failure was already reported; don't loop.
if (input.stop_hook_active) process.exit(0)

const status = run(['git', 'status', '--porcelain', '--untracked-files=all'])
const changed = status.out
  .split('\n')
  .map((line) => line.slice(3).trim().replace(/^"|"$/g, ''))
  .filter((path) => path && isCode(path))
if (changed.length === 0) process.exit(0)

const failures: string[] = []
const lint = run([process.execPath, 'run', 'lint'], undefined, 150_000)
if (lint.code !== 0) failures.push(`bun run lint failed:\n${tail(lint.out, 40)}`)
const tests = run([process.execPath, 'test'], undefined, 150_000)
if (tests.code !== 0 && !/No tests found|0 test files/i.test(tests.out)) {
  failures.push(`bun test failed:\n${tail(tests.out, 40)}`)
}

if (failures.length > 0) {
  console.log(JSON.stringify({ decision: 'block', reason: failures.join('\n\n') }))
}
