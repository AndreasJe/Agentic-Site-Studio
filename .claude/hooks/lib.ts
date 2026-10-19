import { isAbsolute, relative, resolve } from 'node:path'

export type HookInput = {
  tool_name?: string
  tool_input?: { file_path?: string }
  stop_hook_active?: boolean
}

export const projectDir = resolve(process.env.CLAUDE_PROJECT_DIR ?? process.cwd())

export async function readHookInput(): Promise<HookInput> {
  const text = await Bun.stdin.text()
  return text.trim() ? JSON.parse(text) : {}
}

/** Path relative to the project with forward slashes, or null when outside it. */
export function relToProject(file: string): string | null {
  const rel = relative(projectDir, resolve(projectDir, file)).replaceAll('\\', '/')
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  return rel
}

/** Reference files: code is tested against them, so they change only with the user's OK. */
export const REFERENCE = [/^contracts\//, /^design\//, /^docs\/plan\.md$/, /^docs\/decisions\.md$/]

export const CODE = /\.(ts|tsx|js|mjs|cjs|svelte|json|jsonc|css)$/

export function isCode(rel: string): boolean {
  return CODE.test(rel) && !rel.includes('node_modules/') && !REFERENCE.some((r) => r.test(rel))
}

export function run(cmd: string[], cwd = projectDir, timeoutMs = 120_000) {
  const p = Bun.spawnSync(cmd, { cwd, stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs })
  return { code: p.exitCode ?? 1, out: `${p.stdout.toString()}${p.stderr.toString()}` }
}

export function tail(text: string, lines = 60): string {
  return text.trim().split('\n').slice(-lines).join('\n')
}
