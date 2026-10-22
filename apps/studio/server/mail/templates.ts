// Email templates (plan §13.7). Rules that must hold for every template:
// - No link performs an action. A link is the app's address plus a page path, with no query, no
//   fragment and no token; the action happens on that page, after signing in.
// - Nothing user-written is HTML. A Creator's note goes in as plain text with its links defused.
// - Text that came from production (refusal codes) is only mapped to known wording, never shown raw.
export type Lang = 'en' | 'da'

export type MailMessage =
  | { kind: 'publication-requested'; project: string; revision: string; by: string; note?: string }
  | { kind: 'release-accepted'; target: string; release: number }
  | { kind: 'release-refused'; target: string; release?: number; code: string }
  | { kind: 'smoke-switched-back'; target: string; release: number; switchedBack: boolean }
  | {
      kind: 'certificate-expiry'
      target: string
      names: string[]
      notAfter: string
      daysLeft: number
    }
  | { kind: 'admin-key-added'; admin: string; by: string }
  | { kind: 'sent-back'; project: string; by: string; note?: string }

export type MailKind = MailMessage['kind']
export const MAIL_KINDS: MailKind[] = [
  'publication-requested',
  'release-accepted',
  'release-refused',
  'smoke-switched-back',
  'certificate-expiry',
  'admin-key-added',
  'sent-back',
]

export type Rendered = { subject: string; text: string; html: string; links: string[] }

/** The only paths an email may link to. Pages of the app; never an API or a token URL. */
export const MAIL_PAGE_PATH =
  /^\/(admin\/(inbox|deployment|users|mail|review\/[a-z0-9]+-r[1-9][0-9]*)|p\/[a-z0-9]+\/staging)$/

const REVISION = /^[a-z0-9]+-r[1-9][0-9]*$/

/** Replaces control characters (and angle brackets, when `brackets`) with a space. */
function scrub(text: string, opts: { keepNewline?: boolean; brackets?: boolean } = {}): string {
  let out = ''
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0
    const control = c < 0x20 || c === 0x7f
    const keep = opts.keepNewline && c === 0x0a
    const bracket = opts.brackets && (ch === '<' || ch === '>')
    out += (control && !keep) || bracket ? ' ' : ch
  }
  return out
}

const clean = (v: unknown, max = 120) =>
  scrub(String(v ?? ''), { brackets: true })
    .trim()
    .slice(0, max)

/** A note is plain text; make links in it unclickable so it can't pose as one of ours. */
function defuse(note: string): string {
  return scrub(note, { keepNewline: true })

    .replace(/(https?|ftp):\/\//gi, (_m, s: string) => `${s}[:]//`)
    .replace(/\bwww\./gi, 'www[.]')
    .slice(0, 1000)
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const REFUSALS: Record<string, Text> = {
  'hash-mismatch': {
    en: 'the package did not match its signature',
    da: 'pakken passede ikke til signaturen',
  },
  'release-number-not-higher': {
    en: 'the release number was already used',
    da: 'udgivelsesnummeret var allerede brugt',
  },
  replayed: { en: 'the file was already used', da: 'filen var allerede brugt' },
  expired: { en: 'the file had expired', da: 'filen var udløbet' },
  frozen: { en: 'production is frozen', da: 'produktion er frosset' },
  'not-enough-signers': {
    en: 'too few Admins signed',
    da: 'for få administratorer har underskrevet',
  },
  'wrong-target': {
    en: 'the release was for another target',
    da: 'udgivelsen var til et andet mål',
  },
}

type Text = { en: string; da: string }

type Built = {
  subject: Text
  lines: Text[]
  note?: string
  link: { path: string; label: Text }
}

const DEPLOYMENT: Built['link'] = {
  path: '/admin/deployment',
  label: { en: 'Open Deployment', da: 'Åbn Udrulning' },
}

function build(m: MailMessage): Built {
  switch (m.kind) {
    case 'publication-requested': {
      const rev = REVISION.test(m.revision) ? m.revision : null
      const project = clean(m.project)
      const by = clean(m.by)
      return {
        subject: { en: `Publication requested: ${project}`, da: `Udgivelse ønskes: ${project}` },
        lines: [
          {
            en: `${by} asks you to publish ${project}${rev ? ` (${rev})` : ''}.`,
            da: `${by} beder dig om at udgive ${project}${rev ? ` (${rev})` : ''}.`,
          },
          {
            en: 'Nothing happens until an Admin approves it with a passkey in the app.',
            da: 'Intet sker, før en administrator godkender med en adgangsnøgle i appen.',
          },
        ],
        note: m.note ? defuse(m.note) : undefined,
        link: {
          path: rev ? `/admin/review/${rev}` : '/admin/inbox',
          label: { en: 'Open the review page', da: 'Åbn gennemgangen' },
        },
      }
    }
    case 'release-accepted': {
      const target = clean(m.target)
      return {
        subject: {
          en: `Release ${m.release} is live on ${target}`,
          da: `Udgivelse ${m.release} er i luften på ${target}`,
        },
        lines: [
          {
            en: `Production accepted release ${m.release} for ${target} and its smoke test passed.`,
            da: `Produktion accepterede udgivelse ${m.release} til ${target}, og røgtesten bestod.`,
          },
        ],
        link: DEPLOYMENT,
      }
    }
    case 'release-refused': {
      const target = clean(m.target)
      const why = REFUSALS[m.code]
      return {
        subject: {
          en: `Release refused by ${target}`,
          da: `Udgivelse afvist af ${target}`,
        },
        lines: [
          {
            en: `Production refused ${m.release ? `release ${m.release}` : 'a release'}${why ? `: ${why.en}` : '.'}`,
            da: `Produktion afviste ${m.release ? `udgivelse ${m.release}` : 'en udgivelse'}${why ? `: ${why.da}` : '.'}`,
          },
          {
            en: 'The site that was live before is still live.',
            da: 'Sitet, der var i luften før, er stadig i luften.',
          },
        ],
        link: DEPLOYMENT,
      }
    }
    case 'smoke-switched-back': {
      const target = clean(m.target)
      return {
        subject: m.switchedBack
          ? {
              en: `Smoke test failed: ${target} switched back`,
              da: `Røgtest fejlede: ${target} er skiftet tilbage`,
            }
          : {
              en: `Smoke test failed: ${target} is offline`,
              da: `Røgtest fejlede: ${target} er offline`,
            },
        lines: m.switchedBack
          ? [
              {
                en: `Release ${m.release} failed its smoke test, so production switched back to the release before it, by itself.`,
                da: `Udgivelse ${m.release} bestod ikke røgtesten, så produktion skiftede selv tilbage til udgivelsen før.`,
              },
            ]
          : [
              {
                en: `Release ${m.release} failed its smoke test and there was no earlier release to switch back to. The site is offline.`,
                da: `Udgivelse ${m.release} bestod ikke røgtesten, og der var ingen tidligere udgivelse at skifte tilbage til. Sitet er offline.`,
              },
            ],
        link: {
          path: '/admin/inbox',
          label: { en: 'Open Waiting for you', da: 'Åbn Venter på dig' },
        },
      }
    }
    case 'certificate-expiry': {
      const target = clean(m.target)
      const names = m.names.map((n) => clean(n, 80)).join(', ')
      const on = clean(m.notAfter, 10)
      return {
        subject: {
          en: `Certificate for ${target} expires in ${m.daysLeft} days`,
          da: `Certifikat for ${target} udløber om ${m.daysLeft} dage`,
        },
        lines: [
          {
            en: `The certificate for ${names} expires on ${on}. Automatic renewal has not completed.`,
            da: `Certifikatet for ${names} udløber den ${on}. Den automatiske fornyelse er ikke gennemført.`,
          },
        ],
        link: DEPLOYMENT,
      }
    }
    case 'sent-back': {
      const project = clean(m.project)
      const by = clean(m.by)
      const id = /^[a-z0-9]+$/.test(m.project) ? m.project : null
      return {
        subject: { en: `Sent back: ${project}`, da: `Sendt tilbage: ${project}` },
        lines: [
          {
            en: `${by || 'An Admin'} sent ${project} back to you instead of publishing it.`,
            da: `${by || 'En administrator'} har sendt ${project} tilbage til dig i stedet for at udgive det.`,
          },
          {
            en: 'Nothing was published. Read the note, change what is needed and ask again.',
            da: 'Intet er udgivet. Læs noten, ret det nødvendige og bed om udgivelse igen.',
          },
        ],
        note: m.note ? defuse(m.note) : undefined,
        link: {
          path: id ? `/p/${id}/staging` : '/admin/inbox',
          label: { en: 'Open Staging', da: 'Åbn Staging' },
        },
      }
    }
    case 'admin-key-added': {
      const admin = clean(m.admin)
      const by = clean(m.by)
      return {
        subject: { en: 'A new Admin key was added', da: 'En ny administratornøgle er tilføjet' },
        lines: [
          {
            en: `A passkey for ${admin} was added to production's trusted keys, approved by ${by}.`,
            da: `En adgangsnøgle for ${admin} er føjet til produktionens betroede nøgler, godkendt af ${by}.`,
          },
          {
            en: 'If you did not expect this, open the app and check the keys.',
            da: 'Hvis du ikke forventede det, så åbn appen og kontrollér nøglerne.',
          },
        ],
        link: {
          path: '/admin/users',
          label: { en: 'Open Users and keys', da: 'Åbn Brugere og nøgler' },
        },
      }
    }
  }
}

/** `appOrigin` is the configured app address (APP_URL). Links are always `appOrigin` + a page path. */
export function renderMail(m: MailMessage, lang: Lang, appOrigin: string): Rendered {
  const b = build(m)
  if (!MAIL_PAGE_PATH.test(b.link.path)) throw new Error(`not a page path: ${b.link.path}`)
  const url = new URL(b.link.path, appOrigin).toString()
  const subject = b.subject[lang]
  const paragraphs = b.lines.map((l) => l[lang])
  const noteLabel =
    lang === 'da' ? 'Note fra afsenderen (ren tekst):' : 'Note from the sender (plain text):'
  const footer =
    lang === 'da'
      ? 'Dette link åbner kun en side i appen. Alle handlinger sker dér, efter login.'
      : 'This link only opens a page in the app. Every action happens there, after you sign in.'
  const text = [
    ...paragraphs,
    ...(b.note ? ['', noteLabel, b.note] : []),
    '',
    `${b.link.label[lang]}: ${url}`,
    '',
    footer,
  ].join('\n')
  const html = [
    '<!doctype html><html><body style="font-family:sans-serif;line-height:1.5">',
    ...paragraphs.map((p) => `<p>${esc(p)}</p>`),
    ...(b.note
      ? [`<p>${esc(noteLabel)}</p><pre style="white-space:pre-wrap">${esc(b.note)}</pre>`]
      : []),
    `<p><a href="${esc(url)}">${esc(b.link.label[lang])}</a></p>`,
    `<p style="color:#555">${esc(footer)}</p>`,
    '</body></html>',
  ].join('\n')
  return { subject, text, html, links: [url] }
}
