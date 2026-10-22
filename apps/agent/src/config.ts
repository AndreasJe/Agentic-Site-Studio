// The agent's own settings, written by the person who installs it on the production host. Nothing
// here comes from the app: the app's address, keys and numbers arrive in the signed pairing file.
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { SITE } from '@site-studio/shared/release'

export type AgentConfig = {
  /** Holds state/, releases/ and the current link. */
  home: string
  /** Read only: the app writes here over SFTP (decisions #1). */
  inbox: string
  /** Written only by the agent; the app reads it. */
  outbox: string
  /** The one site this agent serves, as in the manifest (example.com or example.com/path). */
  site: string
  /** DNS names a certificate may carry (default: the site's host). A wildcard only if listed. */
  domains: string[]
  hostname: string
  port: number
  /** Releases kept on disk for activate (decisions #35); the active and previous always stay. */
  keep: number
  heartbeatMs: number
  pollMs: number
  /** The one approved video platform host for frame-src (decisions #5), or none. */
  frameSrc: string | null
  maxBundleBytes: number
}

export type ConfigInput = Partial<AgentConfig> & { home: string; site: string }

const DNS = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
const FRAME_HOST = /^https:\/\/([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

export function siteHost(site: string): string {
  return site.split('/')[0] as string
}

/** The site's path part: '' for a whole host, '/campaigns/go' for a path site. */
export function sitePrefix(site: string): string {
  const i = site.indexOf('/')
  return i < 0 ? '' : site.slice(i)
}

export function makeConfig(input: ConfigInput): AgentConfig {
  const home = resolve(input.home)
  const config: AgentConfig = {
    home,
    inbox: resolve(input.inbox ?? join(home, 'inbox')),
    outbox: resolve(input.outbox ?? join(home, 'outbox')),
    site: input.site,
    domains: input.domains ?? [siteHost(input.site)],
    hostname: input.hostname ?? '0.0.0.0',
    port: input.port ?? 8080,
    keep: input.keep ?? 5,
    heartbeatMs: input.heartbeatMs ?? 30_000,
    pollMs: input.pollMs ?? 2_000,
    frameSrc: input.frameSrc ?? null,
    maxBundleBytes: input.maxBundleBytes ?? 600 * 1024 * 1024,
  }
  if (!SITE.test(config.site)) throw new Error(`site is not a live address: ${config.site}`)
  if (config.domains.length === 0 || !config.domains.every((d) => DNS.test(d))) {
    throw new Error('domains must be DNS names')
  }
  if (config.frameSrc !== null && !FRAME_HOST.test(config.frameSrc)) {
    throw new Error('frameSrc must be one https origin')
  }
  if (!Number.isSafeInteger(config.keep) || config.keep < 2) throw new Error('keep must be >= 2')
  for (const k of ['port', 'heartbeatMs', 'pollMs', 'maxBundleBytes'] as const) {
    if (!Number.isSafeInteger(config[k]) || config[k] < 0) throw new Error(`${k} is not a number`)
  }
  return config
}

/** From a JSON file (the install writes it), with AGENT_* environment overrides for ports. */
export function loadConfig(file: string): AgentConfig {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as ConfigInput
  const env = process.env
  return makeConfig({
    ...raw,
    ...(env.AGENT_PORT ? { port: Number(env.AGENT_PORT) } : {}),
    ...(env.AGENT_HOSTNAME ? { hostname: env.AGENT_HOSTNAME } : {}),
  })
}
