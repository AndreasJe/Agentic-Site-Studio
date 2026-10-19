// PreToolUse (Edit|Write): ask the user before any change to the reference files or env files.
import { REFERENCE, readHookInput, relToProject } from './lib.ts'

const ENV = /^\.env(\..+)?$/

const input = await readHookInput()
const file = input.tool_input?.file_path
const rel = file ? relToProject(file) : null

if (rel && rel !== '.env.example' && (ENV.test(rel) || REFERENCE.some((r) => r.test(rel)))) {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: `${rel} is a reference or env file. Code is tested against it, so it changes only with your OK.`,
      },
    }),
  )
}
