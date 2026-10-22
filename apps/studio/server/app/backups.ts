// Backups (M8.1; plan §12.2), Admin only. The passphrase arrives in the body of a run or a
// restore, is used once, and is never stored, logged or audited.
import type { Context, Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { requireCapability } from '../auth/roles.ts'
import { readSchedule } from '../backup/schedule.ts'
import {
  readLastResult,
  readScope,
  readTarget,
  restoreInto,
  runBackupNow,
  saveBackupSettings,
  targetOf,
} from '../backup/service.ts'
import { BackupError } from '../backup/target.ts'
import type { StoreContext } from '../store/revisions.ts'
import type { AppEnv } from './projects.ts'

const STATUS: Record<string, 400 | 404 | 409 | 422 | 502> = {
  'bad-settings': 400,
  'weak-passphrase': 400,
  'bad-name': 400,
  'unknown-project': 404,
  'not-found': 404,
  'no-target': 409,
  'needs-rclone': 409,
  'dest-exists': 409,
  'wrong-passphrase-or-tampered': 422,
  'bad-backup': 422,
  corrupt: 422,
  'hash-mismatch': 422,
}

export function backupRoutes(app: Hono<AppEnv>, ctx: StoreContext, now: () => number = Date.now) {
  const body = async (c: Context<AppEnv>) => {
    const b = (await c.req.json().catch(() => ({}))) as unknown
    return (typeof b === 'object' && b !== null && !Array.isArray(b) ? b : {}) as Record<
      string,
      unknown
    >
  }
  const fail = (c: Context<AppEnv>, e: unknown) => {
    if (e instanceof BackupError)
      return c.json({ code: e.code, message: e.message }, STATUS[e.code] ?? 500)
    throw e
  }

  app.use('/api/admin/backups', requireCapability('backups'))
  app.use('/api/admin/backups/*', requireCapability('backups'))
  app.use(
    '/api/admin/backups/*',
    bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ code: 'too-large' }, 413) }),
  )

  app.get('/api/admin/backups', async (c) => {
    const target = readTarget(ctx.db)
    const backups: unknown[] = []
    let needsRclone = false
    if (target) {
      const store = targetOf(target)
      try {
        for (const f of await store.list()) {
          if (!f.name.endsWith('.ssbak')) continue
          let info: unknown = null
          try {
            info = JSON.parse(new TextDecoder().decode(await store.get(`${f.name}.json`)))
          } catch {}
          backups.push({ name: f.name, size: f.size, modified: f.modified, info })
        }
      } catch (e) {
        if (e instanceof BackupError && e.code === 'needs-rclone') needsRclone = true
        else return fail(c, e)
      }
    }
    return c.json({
      target,
      needsRclone,
      scope: readScope(ctx.db),
      schedule: readSchedule(ctx.db),
      lastResult: readLastResult(ctx.db),
      // The timer needs the passphrase from the environment; a manual run brings its own.
      timerHasPassphrase: !!process.env.BACKUP_PASSPHRASE,
      backups: backups.reverse(),
    })
  })

  app.put('/api/admin/backups/settings', async (c) => {
    try {
      saveBackupSettings(ctx, await body(c))
      return c.json({
        target: readTarget(ctx.db),
        scope: readScope(ctx.db),
        schedule: readSchedule(ctx.db),
      })
    } catch (e) {
      return fail(c, e)
    }
  })

  app.post('/api/admin/backups/run', async (c) => {
    const { passphrase } = await body(c)
    if (typeof passphrase !== 'string' || !passphrase)
      return c.json({ code: 'weak-passphrase', message: 'Enter the passphrase.' }, 400)
    try {
      return c.json({ result: await runBackupNow(ctx, passphrase, c.get('user').handle, now) })
    } catch (e) {
      return fail(c, e)
    }
  })

  app.post('/api/admin/backups/restore', async (c) => {
    const { name, passphrase, destDir } = await body(c)
    if (typeof name !== 'string' || typeof passphrase !== 'string' || typeof destDir !== 'string')
      return c.json(
        { code: 'bad-settings', message: 'Name, passphrase and folder are needed.' },
        400,
      )
    try {
      const r = await restoreInto(ctx, { name, passphrase, destDir }, c.get('user').handle)
      return c.json({ result: { dir: r.dir, files: r.files, createdAt: r.manifest.createdAt } })
    } catch (e) {
      return fail(c, e)
    }
  })
}
