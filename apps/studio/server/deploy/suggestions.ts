// Certificate-name suggestions (decision 22 Oct #8): approved addresses offered in Deployment's
// domains field. Nothing is added automatically; the Admin adds a name with one click.
import { currentRevision, type StoreContext } from '../store/revisions.ts'
import { structureOf } from './address.ts'

export type NameSuggestion = { name: string; project: string; domain: string }

/** The parent of a host name: `www.example.com` -> `example.com`; a two-label name is its own base. */
function baseOf(host: string): string {
  const h = host.replace(/^\*\./, '')
  const labels = h.split('.')
  return labels.length > 2 ? labels.slice(1).join('.') : h
}

/**
 * Names the target's certificate does not carry yet, one per approved address and base. The base is
 * the parent of a name the target already has; with none, the parent of the project's own address.
 * A wildcard the target already has covers its names.
 */
export async function certificateSuggestions(
  ctx: StoreContext,
  target: string,
): Promise<NameSuggestion[]> {
  const row = ctx.db.query('select domains from deploy_targets where target = ?').get(target) as {
    domains: string
  } | null
  let have: string[] = []
  try {
    have = row ? (JSON.parse(row.domains) as string[]) : []
  } catch {}
  const approved = ctx.db
    .query("select project_id, name from address_decisions where status = 'approved' order by name")
    .all() as { project_id: string; name: string }[]
  const out: NameSuggestion[] = []
  for (const a of approved) {
    let bases = [...new Set(have.map(baseOf))]
    if (bases.length === 0 && currentRevision(ctx.dataDir, a.project_id)) {
      const root = (await structureOf(ctx, a.project_id))?.s.roots[0]?.address
      if (root) bases = [baseOf(root)]
    }
    for (const base of bases) {
      const domain = `${a.name}.${base}`
      if (have.includes(domain) || have.includes(`*.${base}`)) continue
      out.push({ name: a.name, project: a.project_id, domain })
    }
  }
  return out
}
