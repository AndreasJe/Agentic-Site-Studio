// "Propose to the guide" (plan §6.6, outcome 3): a deviation becomes a proposal that Brand and
// rules shows later. Here it is only recorded; an Admin or a Creator accepting it is a later step.
import type { StoreContext } from '../store/revisions.ts'
import { deviationOutcome } from './design.ts'

export type GuideProposal = {
  id: number
  project: string
  projectName: string
  deviationId: number
  artboard: string
  rule: string
  message: string
  proposedBy: string
  kind: 'colour' | 'font' | 'other'
  value: string
  status: 'open' | 'accepted' | 'declined'
  createdAt: string
}

/** What is being proposed, read from the validator's own message, never from the model. */
function proposed(
  rule: string,
  message: string,
): { kind: 'colour' | 'font' | 'other'; value: string } {
  if (rule === 'colour') {
    const hex = /\((#[0-9a-f]{6})\)/i.exec(message)?.[1]
    if (hex) return { kind: 'colour', value: hex.toLowerCase() }
  }
  if (rule === 'font') {
    const font = /^Font "(.+)" is not in the guide\.$/.exec(message)?.[1]
    if (font) return { kind: 'font', value: font }
  }
  return { kind: 'other', value: message }
}

export function proposeToGuide(ctx: StoreContext, project: string, id: number, by: string) {
  const { db } = ctx
  return db.transaction(() => {
    // Throws when the deviation is not this project's, or is not open.
    const out = deviationOutcome(ctx, project, id, 'proposed')
    const d = db.query('select rule, message from deviations where id = ?').get(id) as {
      rule: string
      message: string
    }
    const p = proposed(d.rule, d.message)
    const row = db
      .query(
        `insert into guide_proposals (project_id, deviation_id, proposed_by, kind, value, status, created_at)
         values (?, ?, ?, ?, ?, 'open', ?) returning id, kind, value, status`,
      )
      .get(project, id, by, p.kind, p.value, new Date().toISOString()) as {
      id: number
      kind: string
      value: string
      status: string
    }
    return { ...out, proposal: row }
  })()
}

export function listGuideProposals(ctx: StoreContext): GuideProposal[] {
  return ctx.db
    .query(
      `select g.id, g.project_id as project, p.name as projectName, g.deviation_id as deviationId,
         a.letter as artboard, d.rule, d.message, g.proposed_by as proposedBy, g.kind, g.value,
         g.status, g.created_at as createdAt
       from guide_proposals g
       join projects p on p.id = g.project_id
       join deviations d on d.id = g.deviation_id
       join artboards a on a.id = d.artboard_id
       order by g.id desc`,
    )
    .all() as GuideProposal[]
}
