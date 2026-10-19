import { randomBytes } from 'node:crypto'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export class ConfigError extends Error {
  constructor(problems: string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`)
    this.name = 'ConfigError'
  }
}

export type LlmCapability = 'json_schema' | 'json_object' | 'none'

export type Config = {
  appUrl: URL
  previewUrl: URL
  dataDir: string
  appSecret: string
  instanceId: string
  instanceIdGenerated: boolean
  llmBaseUrl: URL
  llmApiKey: string
  llmModel: string
  llmCapability: LlmCapability
}

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const CAPABILITIES: LlmCapability[] = ['json_schema', 'json_object', 'none']
const INVALID = new URL('http://invalid.invalid')

type Env = Record<string, string | undefined>

/** Same host, or (without a public-suffix list) the same last two labels: treat as one site. */
export function sameSite(a: string, b: string): boolean {
  if (a === b) return true
  const ip = /^[d.]+$|:/
  if (ip.test(a) || ip.test(b)) return false
  const tail = (h: string) => h.split('.').slice(-2).join('.')
  return a.includes('.') && b.includes('.') && tail(a) === tail(b)
}

export function loadConfig(env: Env = process.env): Config {
  const problems: string[] = []
  const get = (key: string) => env[key]?.trim() || undefined
  const need = (key: string) => {
    const v = get(key)
    if (!v) problems.push(`${key} is required`)
    return v ?? ''
  }
  const url = (key: string, value: string) => {
    try {
      const u = new URL(value)
      if (u.protocol === 'http:' || u.protocol === 'https:') return u
    } catch {}
    problems.push(`${key} must be an http or https URL, got "${value}"`)
    return INVALID
  }

  const appUrl = url('APP_URL', get('APP_URL') ?? 'http://localhost:3000')
  const previewUrl = url('PREVIEW_URL', get('PREVIEW_URL') ?? 'http://127.0.0.1:3001')
  if (
    appUrl !== INVALID &&
    previewUrl !== INVALID &&
    sameSite(appUrl.hostname, previewUrl.hostname)
  ) {
    problems.push(
      'PREVIEW_URL must be a different site from APP_URL, not another port or a sibling subdomain (rule 4)',
    )
  }

  let dataDir = need('DATA_DIR')
  if (dataDir) {
    if (!isAbsolute(dataDir)) problems.push('DATA_DIR must be an absolute path')
    else {
      dataDir = resolve(dataDir)
      const rel = relative(REPO_ROOT, dataDir)
      if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
        problems.push(`DATA_DIR must be outside the repo (${REPO_ROOT})`)
      }
      if (dataDir.split(sep).some((part) => part.toLowerCase().includes('onedrive'))) {
        problems.push('DATA_DIR must not be inside OneDrive (sync would corrupt revisions)')
      }
    }
  }

  const appSecret = need('APP_SECRET')
  if (appSecret && appSecret.length < 32) problems.push('APP_SECRET must be at least 32 characters')

  const llmBase = need('LLM_BASE_URL')
  const llmBaseUrl = llmBase ? url('LLM_BASE_URL', llmBase) : INVALID
  const llmApiKey = need('LLM_API_KEY')
  const llmModel = need('LLM_MODEL')

  const cap = get('LLM_CAPABILITY') ?? 'json_schema'
  if (!CAPABILITIES.includes(cap as LlmCapability)) {
    problems.push(`LLM_CAPABILITY must be one of ${CAPABILITIES.join(', ')}, got "${cap}"`)
  }

  const given = get('INSTANCE_ID')

  if (problems.length) throw new ConfigError(problems)
  return {
    appUrl,
    previewUrl,
    dataDir,
    appSecret,
    instanceId: given ?? `inst-${randomBytes(6).toString('hex')}`,
    instanceIdGenerated: !given,
    llmBaseUrl,
    llmApiKey,
    llmModel,
    llmCapability: cap as LlmCapability,
  }
}
