import { Database } from 'bun:sqlite'

// Provisional: `outcome` stays 'pending' until open questions B5/B6 decide who sets
// kept / discarded / reverted. One row per HTTP attempt (plan §15 plus call_id, attempt, status, error).
export type UsageMeta = {
  project?: string
  phase?: string
  action?: string
  task_class?: string
  user?: string
  revision?: string
  model_role?: string
}

export type UsageRow = UsageMeta & {
  call_id: string
  attempt: number
  provider: string
  endpoint: string
  model: string
  input_tokens: number
  output_tokens: number
  cached_tokens: number
  latency_ms: number
  retries: number
  valid_first_try: 0 | 1
  outcome: 'pending' | 'kept' | 'discarded' | 'reverted'
  estimated: 0 | 1
  status: string
  error: string | null
}

const columns = [
  'call_id',
  'attempt',
  'project',
  'phase',
  'action',
  'task_class',
  'user',
  'revision',
  'provider',
  'endpoint',
  'model',
  'model_role',
  'input_tokens',
  'output_tokens',
  'cached_tokens',
  'latency_ms',
  'retries',
  'valid_first_try',
  'outcome',
  'estimated',
  'status',
  'error',
] as const

export function openUsage(path = ':memory:'): Database {
  const db = new Database(path)
  db.run(`CREATE TABLE IF NOT EXISTS usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    call_id TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    project TEXT, phase TEXT, action TEXT, task_class TEXT, user TEXT, revision TEXT,
    provider TEXT NOT NULL, endpoint TEXT NOT NULL, model TEXT NOT NULL, model_role TEXT,
    input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cached_tokens INTEGER NOT NULL,
    latency_ms INTEGER NOT NULL, retries INTEGER NOT NULL, valid_first_try INTEGER NOT NULL,
    outcome TEXT NOT NULL DEFAULT 'pending', estimated INTEGER NOT NULL,
    status TEXT NOT NULL, error TEXT
  )`)
  return db
}

export function insertUsage(db: Database, row: UsageRow): void {
  const sql = `INSERT INTO usage (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`
  db.query(sql).run(...columns.map((c) => row[c] ?? null))
}

export function usageRows(db: Database): UsageRow[] {
  return db.query('SELECT * FROM usage ORDER BY id').all() as UsageRow[]
}

// No tokenizer dependency: a rough chars/4 estimate, always flagged estimated = 1.
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4)
