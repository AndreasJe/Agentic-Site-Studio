import { join } from 'node:path'
import { createApp } from './app/index.ts'
import { issueSetupCodes } from './auth/passkeys.ts'
import { seedTestAccounts } from './auth/seed.ts'
import { scheduledTick } from './backup/service.ts'
import { loadConfig } from './config.ts'
import { openDb } from './db/index.ts'
import { maintainCertificates } from './deploy/certs.ts'
import { registerDeployHooks } from './deploy/events.ts'
import { onOutbox, startOutboxPolling } from './deploy/outbox.ts'
import { endpointFromConfig } from './llm/index.ts'
import { createPreview } from './preview/index.ts'
import { applyUsageRetention } from './usage/stats.ts'

const config = loadConfig()
if (config.instanceIdGenerated) {
  console.log(`INSTANCE_ID not set; generated ${config.instanceId}. Set it in .env to keep it.`)
}

const listen = (url: URL, fetch: (req: Request) => Response | Promise<Response>) =>
  Bun.serve({ hostname: url.hostname, port: Number(url.port || 80), fetch })

const db = openDb(join(config.dataDir, 'studio.sqlite'))
seedTestAccounts(db) // concept only (plan §14)
// One-time setup codes for Admins without a passkey (plan §13.8), shown once.
for (const [handle, code] of Object.entries(issueSetupCodes(db, Date.now()))) {
  console.log(`Setup code for Admin ${handle}: ${code}  (one use, expires in 24 hours)`)
}
// Deployment side (M7): outbox events (certificate requests, failed smoke tests), certificate
// renewal once an hour. No issuer is configured yet: ACME needs a DNS provider and the VM, so
// certificate requests are recorded as failed ("no issuer") until one is set up.
const deployCtx = { db, dataDir: config.dataDir, instanceId: config.instanceId }
const certDeps = { ctx: deployCtx, issuer: null, mail: { appOrigin: config.appUrl.origin } }
registerDeployHooks(onOutbox, certDeps)
startOutboxPolling(deployCtx)
setInterval(() => void maintainCertificates(certDeps).catch(() => {}), 3600_000).unref()
// M8: usage retention once an hour; backups when a schedule is set (the passphrase comes from
// BACKUP_PASSPHRASE in the environment, never from the database).
const storeCtx = { db, dataDir: config.dataDir, instanceId: config.instanceId }
setInterval(() => {
  try {
    applyUsageRetention(db)
  } catch {}
  void scheduledTick(storeCtx, process.env.BACKUP_PASSPHRASE).catch(() => {})
}, 3600_000).unref()
listen(config.appUrl, createApp({ ...config, db, llmEndpoint: endpointFromConfig(config) }).fetch)
listen(config.previewUrl, createPreview(config).fetch)
console.log(`app ${config.appUrl.origin}  preview ${config.previewUrl.origin}`)
