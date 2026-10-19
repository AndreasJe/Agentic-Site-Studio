// Test accounts for the concept (plan §14; decision #41): 2 Admins, passkey only, and 20 Creators
// whose password is their handle. Concept only: replaced before production (§21.6).
import type { Database } from 'bun:sqlite'

const ADMINS = ['admina', 'adminb'] // placeholders; real Admin names come at install
const CREATORS = [
  'alex',
  'rune',
  ...'abcdefghijklmnopqr'.split('').map((l) => `creator${l}`), // placeholders
]

export function seedTestAccounts(db: Database) {
  const insert = db.query(
    'insert or ignore into users (handle, name, role, password_hash, created_at) values (?, ?, ?, ?, ?)',
  )
  const at = new Date().toISOString()
  db.transaction(() => {
    for (const h of ADMINS) insert.run(h, h, 'admin', null, at)
    for (const h of CREATORS) {
      // A cheap hash cost is fine for test passwords that equal the handle.
      insert.run(
        h,
        h[0]?.toUpperCase() + h.slice(1),
        'creator',
        Bun.password.hashSync(h, { algorithm: 'argon2id', memoryCost: 4096, timeCost: 2 }),
        at,
      )
    }
  })()
}
