// Microsoft 365 mail (OAuth, client credentials): one access token for outlook.office365.com,
// cached until shortly before it expires. The secret is only ever sent to the token endpoint.
import { createHash } from 'node:crypto'

export const M365_SCOPE = 'https://outlook.office365.com/.default'
export const m365TokenUrl = (tenant: string) =>
  `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`

export type TokenDeps = {
  /** The token endpoint for a tenant. Injectable so tests never reach Microsoft. */
  tokenUrl?: (tenant: string) => string
  now?: () => number
  timeoutMs?: number
}

export class TokenError extends Error {}

type Cached = { token: string; expiresAt: number }
const cache = new Map<string, Cached>()
const SKEW_MS = 60_000

/** Forgets cached tokens (tests, and after the settings change). */
export const clearTokenCache = () => cache.clear()

export async function getAccessToken(
  creds: { tenantId: string; clientId: string; clientSecret: string },
  deps: TokenDeps = {},
): Promise<string> {
  if (!creds.clientSecret) throw new TokenError('The client secret is not set.')
  const now = (deps.now ?? Date.now)()
  // Keyed by a digest, so a changed secret or tenant never reuses an old token.
  const key = createHash('sha256')
    .update([creds.tenantId, creds.clientId, creds.clientSecret].join('\0'))
    .digest('hex')
  const hit = cache.get(key)
  if (hit && hit.expiresAt - SKEW_MS > now) return hit.token
  const url = (deps.tokenUrl ?? m365TokenUrl)(creds.tenantId)
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        scope: M365_SCOPE,
      }),
      signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
    })
  } catch {
    throw new TokenError('Could not reach the Microsoft sign-in service.')
  }
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: unknown
    expires_in?: unknown
    error?: unknown
  }
  if (!res.ok || typeof body.access_token !== 'string' || !body.access_token) {
    const code =
      typeof body.error === 'string' ? body.error.replace(/[^\w.-]/g, '').slice(0, 60) : ''
    throw new TokenError(`Microsoft refused the sign-in (${res.status}${code ? `, ${code}` : ''}).`)
  }
  const seconds = Number(body.expires_in)
  const ttl = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0
  cache.set(key, { token: body.access_token, expiresAt: now + ttl })
  return body.access_token
}
