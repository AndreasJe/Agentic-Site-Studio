// PostToolUse (Edit|Write): format and lint the edited file, then run its package's tests.
// Exit 2 sends the output back to Claude so it is fixed straight away.
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isCode, projectDir, readHookInput, relToProject, run, tail } from './lib.ts'

const input = await readHookInput()
const file = input.tool_input?.file_path
const rel = file ? relToProject(file) : null
if (!rel || !isCode(rel)) process.exit(0)

const abs = join(projectDir, rel)
const lint = run([
  process.execPath,
  'x',
  'biome',
  'check',
  '--write',
  '--no-errors-on-unmatched',
  abs,
])
if (lint.code !== 0) {
  console.error(`Biome found problems in ${rel}:\n${tail(lint.out)}`)
  process.exit(2)
}

// Nearest package below the root; the root suite runs in the Stop hook.
let dir = dirname(abs)
while (dir.startsWith(projectDir) && dir !== projectDir && !existsSync(join(dir, 'package.json'))) {
  dir = dirname(dir)
}
if (dir === projectDir || !dir.startsWith(projectDir)) process.exit(0)

const tests = run([process.execPath, 'test'], dir, 80_000)
if (tests.code !== 0 && !/No tests found|0 test files/i.test(tests.out)) {
  console.error(`Tests failed in ${relToProject(dir)}:\n${tail(tests.out)}`)
  process.exit(2)
}
