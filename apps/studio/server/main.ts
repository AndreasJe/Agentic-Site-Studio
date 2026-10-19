import { join } from 'node:path'
import { createApp } from './app/index.ts'
import { issueSetupCodes } from './auth/passkeys.ts'
import { seedTestAccounts } from './auth/seed.ts'
import { loadConfig } from './config.ts'
import { openDb } from './db/index.ts'
import { endpointFromConfig } from './llm/index.ts'
import { createPreview } from './preview/index.ts'

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
listen(config.appUrl, createApp({ ...config, db, llmEndpoint: endpointFromConfig(config) }).fetch)
listen(config.previewUrl, createPreview(config).fetch)
console.log(`app ${config.appUrl.origin}  preview ${config.previewUrl.origin}`)
