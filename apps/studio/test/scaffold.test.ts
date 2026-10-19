import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createApp } from '../server/app/index.ts'
import { ConfigError, loadConfig } from '../server/config.ts'
import { createPreview } from '../server/preview/index.ts'

const good = {
  APP_URL: 'http://localhost:3000',
  PREVIEW_URL: 'http://127.0.0.1:3001',
  DATA_DIR: join(process.platform === 'win32' ? 'C:/' : '/', 'site-studio-data'),
  APP_SECRET: 'x'.repeat(32),
  INSTANCE_ID: 'inst-test',
  LLM_BASE_URL: 'http://localhost:11434/v1',
  LLM_API_KEY: 'test-key',
  LLM_MODEL: 'test-model',
  LLM_CAPABILITY: 'json_schema',
}

const without = (key: string) => {
  const { [key]: _, ...rest } = good as Record<string, string>
  return rest
}

describe('config', () => {
  test('accepts a complete environment', () => {
    const c = loadConfig(good)
    expect(c.appUrl.origin).toBe('http://localhost:3000')
    expect(c.llmCapability).toBe('json_schema')
  })

  test('dev defaults for the two URLs', () => {
    const c = loadConfig({ ...without('APP_URL'), PREVIEW_URL: undefined } as never)
    expect(c.appUrl.origin).toBe('http://localhost:3000')
    expect(c.previewUrl.origin).toBe('http://127.0.0.1:3001')
  })

  test('generates and reports a missing INSTANCE_ID', () => {
    const c = loadConfig(without('INSTANCE_ID'))
    expect(c.instanceId).toMatch(/^[a-z0-9-]{8,}$/)
    expect(c.instanceIdGenerated).toBe(true)
  })

  for (const key of ['DATA_DIR', 'APP_SECRET', 'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL']) {
    test(`names ${key} when missing`, () => {
      expect(() => loadConfig(without(key))).toThrow(new RegExp(key))
    })
  }

  test('rejects invalid values', () => {
    expect(() => loadConfig({ ...good, APP_URL: 'not a url' })).toThrow(/APP_URL/)
    expect(() => loadConfig({ ...good, LLM_CAPABILITY: 'maybe' })).toThrow(/LLM_CAPABILITY/)
    expect(() => loadConfig({ ...good, APP_SECRET: 'short' })).toThrow(/APP_SECRET/)
    expect(() => loadConfig({ ...good, LLM_BASE_URL: 'ftp://x' })).toThrow(/LLM_BASE_URL/)
    expect(() => loadConfig({ ...good, DATA_DIR: 'relative/dir' })).toThrow(/DATA_DIR/)
  })

  test('app and preview must be different origins', () => {
    expect(() => loadConfig({ ...good, PREVIEW_URL: good.APP_URL })).toThrow(/PREVIEW_URL/)
  })

  test('refuses a DATA_DIR inside the repo', () => {
    const repo = join(import.meta.dir, '..', '..', '..')
    expect(() => loadConfig({ ...good, DATA_DIR: join(repo, 'data') })).toThrow(/repo/)
    expect(() => loadConfig({ ...good, DATA_DIR: repo })).toThrow(/repo/)
  })

  test('refuses a DATA_DIR inside OneDrive', () => {
    const dir = join(good.DATA_DIR, '..', 'OneDrive - Acme', 'data')
    expect(() => loadConfig({ ...good, DATA_DIR: dir })).toThrow(/OneDrive/)
    expect(() => loadConfig({ ...good, DATA_DIR: dir.toLowerCase() })).toThrow(/OneDrive/)
  })

  test('errors are ConfigError and list every problem', () => {
    try {
      loadConfig({})
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError)
      expect((e as Error).message).toMatch(/DATA_DIR[\s\S]*APP_SECRET/)
    }
  })
})

describe('preview host', () => {
  const preview = createPreview({ appUrl: new URL(good.APP_URL) })
  const contract = readFileSync(join(import.meta.dir, '../../../contracts/csp.txt'), 'utf8').trim()
  const expected = contract
    .replace('frame-src <approved video platform host>', "frame-src 'none'")
    .replace("frame-ancestors 'none'", "frame-ancestors 'self' http://localhost:3000")

  test('expected CSP differs from the contract only where decision #38 says', () => {
    expect(expected).not.toContain('<')
    expect(expected).toContain("frame-src 'none'")
    expect(expected).toContain("frame-ancestors 'self' http://localhost:3000")
  })

  const paths = ['/api/health', '/', '/r/', '/r/p-r1/index.html', '/r/p-r1/', '/nope', '/r']

  for (const path of paths) {
    test(`${path}: 404, CSP, no cookie`, async () => {
      const res = await preview.request(path)
      expect(res.status).toBe(404)
      expect(res.headers.get('content-security-policy')).toBe(expected)
      expect(res.headers.get('set-cookie')).toBeNull()
    })
  }

  test('non-GET methods are 404 with the CSP too', async () => {
    const res = await preview.request('/r/p-r1/index.html', { method: 'POST' })
    expect(res.status).toBe(404)
    expect(res.headers.get('content-security-policy')).toBe(expected)
  })

  test('ignores incoming cookies', async () => {
    const res = await preview.request('/api/health', { headers: { cookie: 'session=abc' } })
    expect(res.headers.get('set-cookie')).toBeNull()
  })
})

describe('app host', () => {
  const app = createApp({ appUrl: new URL(good.APP_URL), instanceId: 'inst-test' })

  test('serves /api/health', async () => {
    const res = await app.request('/api/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, instanceId: 'inst-test' })
  })

  test('unknown /api paths are 404 json, not the SPA', async () => {
    const res = await app.request('/api/nope')
    expect(res.status).toBe(404)
  })
})
