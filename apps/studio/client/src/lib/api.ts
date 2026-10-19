// fetch with the session cookie and the CSRF token on every state-changing request.
let csrf = ''

export const setCsrf = (token: string) => {
  csrf = token
}

export type Reply<T> = { status: number; ok: boolean; body: T }

export async function api<T = Record<string, unknown>>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<Reply<T>> {
  const headers: Record<string, string> = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (method !== 'GET') headers['x-csrf-token'] = csrf
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const parsed = (await res.json().catch(() => ({}))) as T
  return { status: res.status, ok: res.ok, body: parsed }
}
