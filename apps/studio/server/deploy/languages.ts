// Site settings > Languages (decision #9): off by default. When on, the site is published in the
// listed languages, each non-default one under its own subpath (/da/...). No hreflang, no
// per-language metadata or sitemaps. "Translated" stays a completeness check and decides nothing.
// One row per site (project).
import type { SessionUser } from '../auth/sessions.ts'
import { audit } from '../governance/audit.ts'
import type { StoreContext } from '../store/revisions.ts'

export class LanguagesError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 404 = 400,
  ) {
    super(message)
  }
}

export type SiteLanguage = { code: string; name: string }
export type SiteLanguages = {
  project: string
  enabled: boolean
  /** Served at the site's root. */
  default: string | null
  languages: SiteLanguage[]
  /** The subpath each language is served under; the default has none. */
  subpaths: Record<string, string>
}

const CODE = /^[a-z]{2,3}$/
const MAX_LANGUAGES = 12
/** A language code must not shadow a folder the site itself uses. */
const RESERVED_PATHS = ['css', 'js', 'img', 'assets', 'static', 'media']

const subpathsOf = (languages: SiteLanguage[], def: string | null) =>
  Object.fromEntries(languages.filter((l) => l.code !== def).map((l) => [l.code, `/${l.code}/`]))

export function getSiteLanguages(ctx: StoreContext, project: string): SiteLanguages {
  if (!ctx.db.query('select 1 from projects where id = ?').get(project))
    throw new LanguagesError('not-found', 'No such site.', 404)
  const row = ctx.db.query('select * from site_languages where project_id = ?').get(project) as {
    enabled: number
    default_language: string | null
    languages: string
  } | null
  if (!row) return { project, enabled: false, default: null, languages: [], subpaths: {} }
  const languages = JSON.parse(row.languages) as SiteLanguage[]
  return {
    project,
    enabled: row.enabled === 1,
    default: row.default_language,
    languages,
    subpaths: row.enabled === 1 ? subpathsOf(languages, row.default_language) : {},
  }
}

export function setSiteLanguages(
  ctx: StoreContext,
  admin: SessionUser,
  project: string,
  input: Record<string, unknown>,
): SiteLanguages {
  const before = getSiteLanguages(ctx, project)
  if (typeof input.enabled !== 'boolean')
    throw new LanguagesError('bad-enabled', 'Turn languages on or off.')
  const raw = input.languages === undefined ? before.languages : input.languages
  if (!Array.isArray(raw) || raw.length > MAX_LANGUAGES)
    throw new LanguagesError('bad-languages', `Add up to ${MAX_LANGUAGES} languages.`)
  const languages: SiteLanguage[] = []
  for (const item of raw) {
    const o = (typeof item === 'string' ? { code: item } : item) as Record<string, unknown> | null
    const code = typeof o?.code === 'string' ? o.code.toLowerCase() : ''
    if (!CODE.test(code) || RESERVED_PATHS.includes(code))
      throw new LanguagesError(
        'bad-code',
        'A language code is two or three letters, like da or en.',
      )
    if (languages.some((l) => l.code === code))
      throw new LanguagesError('duplicate-language', `${code} is listed twice.`)
    const name = typeof o?.name === 'string' ? o.name.trim().slice(0, 60) : ''
    languages.push({ code, name: name || code })
  }
  const def =
    input.default === undefined
      ? before.default
      : typeof input.default === 'string'
        ? input.default.toLowerCase()
        : null
  if (input.enabled) {
    if (languages.length === 0)
      throw new LanguagesError('no-languages', 'List at least one language before turning this on.')
    if (!def || !languages.some((l) => l.code === def))
      throw new LanguagesError('bad-default', 'Pick the default language from the list.')
  } else if (def !== null && !languages.some((l) => l.code === def)) {
    throw new LanguagesError('bad-default', 'The default language must be in the list.')
  }
  ctx.db
    .query(
      `insert into site_languages (project_id, enabled, default_language, languages, updated_by, updated_at)
       values (?, ?, ?, ?, ?, ?)
       on conflict (project_id) do update set enabled = excluded.enabled,
         default_language = excluded.default_language, languages = excluded.languages,
         updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    )
    .run(
      project,
      input.enabled ? 1 : 0,
      def,
      JSON.stringify(languages),
      admin.handle,
      new Date().toISOString(),
    )
  audit(ctx, admin.handle, 'site-languages.changed', {
    project,
    enabled: input.enabled,
    languages: languages.map((l) => l.code),
  })
  return getSiteLanguages(ctx, project)
}
