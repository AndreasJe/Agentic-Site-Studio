// Brief board strings (plan §4.9 question set v1; design/prototype/Brief.dc.html). The Danish is
// a first draft written for M2; a Danish speaker should review it.
import { i18n } from './i18n.svelte.ts'

type Block = { title: string; question: string; guiding: string[] }

const en = {
  blocks: {
    scope: {
      title: 'Scope',
      question: 'What are we making, and why now?',
      guiding: [
        'Is it a whole site, a section or one page?',
        'What triggered it: a launch, a new offering, outdated content, a campaign?',
      ],
    },
    audience: {
      title: 'Audience',
      question: 'Who is the main visitor?',
      guiding: [
        'What is their role?',
        'What do they already know about us, and about the subject?',
        'What problem are they trying to solve when they arrive?',
      ],
    },
    core_message: {
      title: 'Core message',
      question: 'What is the one thing a visitor should remember?',
      guiding: [
        'Why should they believe it?',
        'Is AI the headline of the story, or the support for it?',
      ],
    },
    calls_to_action: {
      title: 'Calls to action',
      question: 'What should the visitor do next?',
      guiding: [
        'What is the primary action, and is there a secondary one?',
        'What does the visitor get, and what happens after they click?',
      ],
    },
    proof_available: {
      title: 'Proof available',
      question: 'What can we show to back it up?',
      guiding: [
        'Customer stories, analyst reports or awards, certifications?',
        'Which results or numbers can we stand behind?',
      ],
    },
    ways_in: {
      title: 'Ways in',
      question: 'How do visitors find this?',
      guiding: [
        'Search, campaigns, LinkedIn, partners, sales emails, events?',
        'What do they expect to see first when they land?',
      ],
    },
    pages_and_jobs: {
      title: 'Pages and their jobs',
      question: 'Which pages do we need, and what is each page’s job?',
      guiding: ['Which are decided, and which are proposals?'],
    },
    how_we_know: {
      title: 'How we’ll know it works',
      question: 'What should change after launch?',
      guiding: [
        'Which signal matters most: demo requests, trials, downloads, time on page?',
        'Is there a target, or just a direction?',
      ],
    },
    tone_and_feel: {
      title: 'Tone and feel',
      question: 'How should it feel?',
      guiding: [
        'Three words for the tone.',
        'How alive should it be: calm and still, or expressive with motion and 3D?',
        'A site you admire, and what you admire about it.',
      ],
    },
    left_out: {
      title: 'Left out on purpose',
      question: 'What are we deliberately not saying or showing?',
      guiding: ['Products, audiences or claims to leave out.'],
    },
  } as Record<string, Block>,
  heading: 'Brief',
  sub: 'Every block has a source. Anything without one stays “Not set yet.” and becomes an open question.',
  notSet: 'Not set yet.',
  ways: 'Ways in',
  guided: 'Guided questions',
  guidedDesc: 'One question per open block. Skip any.',
  prompt: 'One prompt',
  promptDesc: 'Paste notes or an email; the AI sorts it.',
  material: 'Material',
  materialDesc: 'Drop a text, Markdown or PDF file.',
  importLater: 'Import and Duplicate come once Bjarke’s brief format is in.',
  open: 'Open questions',
  openNone: 'No open questions.',
  openNote: 'Open questions never block approval.',
  log: 'Change log',
  logNone: 'No changes yet.',
  filled: 'set',
  cleared: 'cleared',
  edited: 'edited',
  sourceUser: '{by} · own text',
  sourceDoc: 'Document',
  sourceBrief: 'From brief {ref}',
  aiSorted: 'sorted by the AI',
  edit: 'Edit',
  save: 'Save block',
  saveNote: 'Saves to your draft, with you as the source.',
  clear: 'Mark as not set yet',
  followUps: 'Ask me follow-ups',
  tighten: 'Tighten',
  useThis: 'Use this text',
  keepMine: 'Keep mine',
  close: 'Close',
  ctaLabel: 'Button text',
  ctaTarget: 'Where it goes (page ID or https link)',
  ctaGets: 'What the visitor gets',
  ctaPrimary: 'Primary',
  ctaSecondary: 'Secondary',
  ctaAdd: 'Add a call to action',
  ctaRemove: 'Remove',
  promptLabel: 'Notes, an email or a description',
  sort: 'Sort into blocks',
  sorting: 'Sorting…',
  proposal: 'The AI’s proposal',
  proposalNote: 'Nothing is kept until you apply it. Untick what you don’t want.',
  leftOut: 'Left out (fits no block)',
  apply: 'Apply selected blocks',
  next: 'Save and next',
  skip: 'Skip',
  guidedDone: 'No more open blocks.',
  approve: 'Approve brief',
  approved: 'Approved',
  approveNote:
    'Open questions never block approval. Editing a block afterwards returns the brief to draft.',
  approvalOff: 'Brief approval is off for this install.',
  noModel: 'No AI model is set up yet. An Admin adds one under Models.',
  aiFailed: 'The AI’s answer didn’t pass the checks. Nothing was changed.',
  did: 'The AI only proposes here. People apply every change.',
  tokens: '~{lo}–{hi} tokens',
}

type Strings = typeof en

const da: Strings = {
  ...en,
  blocks: {
    scope: {
      title: 'Omfang',
      question: 'Hvad laver vi, og hvorfor nu?',
      guiding: en.blocks.scope?.guiding ?? [],
    },
    audience: {
      title: 'Målgruppe',
      question: 'Hvem er den vigtigste besøgende?',
      guiding: en.blocks.audience?.guiding ?? [],
    },
    core_message: {
      title: 'Kernebudskab',
      question: 'Hvad er det ene, en besøgende skal huske?',
      guiding: en.blocks.core_message?.guiding ?? [],
    },
    calls_to_action: {
      title: 'Handlingsopfordringer',
      question: 'Hvad skal den besøgende gøre bagefter?',
      guiding: en.blocks.calls_to_action?.guiding ?? [],
    },
    proof_available: {
      title: 'Dokumentation',
      question: 'Hvad kan vi vise for at bakke det op?',
      guiding: en.blocks.proof_available?.guiding ?? [],
    },
    ways_in: {
      title: 'Veje ind',
      question: 'Hvordan finder de besøgende det?',
      guiding: en.blocks.ways_in?.guiding ?? [],
    },
    pages_and_jobs: {
      title: 'Sider og deres opgaver',
      question: 'Hvilke sider skal vi bruge, og hvad er hver sides opgave?',
      guiding: en.blocks.pages_and_jobs?.guiding ?? [],
    },
    how_we_know: {
      title: 'Sådan ved vi, at det virker',
      question: 'Hvad skal ændre sig efter lancering?',
      guiding: en.blocks.how_we_know?.guiding ?? [],
    },
    tone_and_feel: {
      title: 'Tone og følelse',
      question: 'Hvordan skal det føles?',
      guiding: en.blocks.tone_and_feel?.guiding ?? [],
    },
    left_out: {
      title: 'Udeladt med vilje',
      question: 'Hvad siger eller viser vi bevidst ikke?',
      guiding: en.blocks.left_out?.guiding ?? [],
    },
  },
  heading: 'Brief',
  sub: 'Hver blok har en kilde. Alt uden kilde forbliver “Ikke udfyldt endnu.” og bliver et åbent spørgsmål.',
  notSet: 'Ikke udfyldt endnu.',
  ways: 'Veje ind',
  guided: 'Guidede spørgsmål',
  guidedDesc: 'Ét spørgsmål pr. åben blok. Spring over efter behov.',
  prompt: 'Én prompt',
  promptDesc: 'Indsæt noter eller en mail; AI’en sorterer det.',
  material: 'Materiale',
  materialDesc: 'Slip en tekst-, Markdown- eller PDF-fil.',
  importLater: 'Import og Dupliker kommer, når Bjarkes brief-format er på plads.',
  open: 'Åbne spørgsmål',
  openNone: 'Ingen åbne spørgsmål.',
  openNote: 'Åbne spørgsmål blokerer aldrig godkendelse.',
  log: 'Ændringslog',
  logNone: 'Ingen ændringer endnu.',
  filled: 'udfyldt',
  cleared: 'ryddet',
  edited: 'redigeret',
  sourceUser: '{by} · egen tekst',
  sourceDoc: 'Dokument',
  sourceBrief: 'Fra brief {ref}',
  aiSorted: 'sorteret af AI’en',
  edit: 'Rediger',
  save: 'Gem blok',
  saveNote: 'Gemmes i din kladde, med dig som kilde.',
  clear: 'Markér som ikke udfyldt',
  followUps: 'Stil mig opfølgende spørgsmål',
  tighten: 'Stram op',
  useThis: 'Brug denne tekst',
  keepMine: 'Behold min',
  close: 'Luk',
  ctaLabel: 'Knaptekst',
  ctaTarget: 'Hvor den fører hen (side-ID eller https-link)',
  ctaGets: 'Hvad den besøgende får',
  ctaPrimary: 'Primær',
  ctaSecondary: 'Sekundær',
  ctaAdd: 'Tilføj en handlingsopfordring',
  ctaRemove: 'Fjern',
  promptLabel: 'Noter, en mail eller en beskrivelse',
  sort: 'Sortér i blokke',
  sorting: 'Sorterer…',
  proposal: 'AI’ens forslag',
  proposalNote: 'Intet gemmes, før du anvender det. Fjern fluebenet ved det, du ikke vil have.',
  leftOut: 'Udeladt (passer ikke i nogen blok)',
  apply: 'Anvend valgte blokke',
  next: 'Gem og næste',
  skip: 'Spring over',
  guidedDone: 'Ikke flere åbne blokke.',
  approve: 'Godkend brief',
  approved: 'Godkendt',
  approveNote:
    'Åbne spørgsmål blokerer aldrig godkendelse. Redigerer du en blok bagefter, bliver briefen en kladde igen.',
  approvalOff: 'Godkendelse af briefs er slået fra i denne installation.',
  noModel: 'Der er endnu ingen AI-model sat op. En Admin tilføjer en under Modeller.',
  aiFailed: 'AI’ens svar bestod ikke kontrollen. Intet blev ændret.',
  did: 'AI’en foreslår kun her. Mennesker anvender hver ændring.',
  tokens: '~{lo}–{hi} tokens',
}

export function b(): Strings {
  return i18n.lang === 'da' ? da : en
}

export const fill = (s: string, vars: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''))

/** A token range before running (decision #42: from the input size until there is history). */
export function tokenRange(chars: number) {
  const base = Math.max(200, Math.round(chars / 4)) + 400
  return { lo: Math.round(base * 0.8), hi: Math.round(base * 1.6) }
}
