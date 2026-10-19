import { join } from 'node:path'
import { createApp } from './app/index.ts'
import { seedTestAccounts } from './auth/seed.ts'
import { loadConfig } from './config.ts'
import { openDb } from './db/index.ts'
import { createPreview } from './preview/index.ts'

const config = loadConfig()
if (config.instanceIdGenerated) {
  console.log(`INSTANCE_ID not set; generated ${config.instanceId}. Set it in .env to keep it.`)
}

const listen = (url: URL, fetch: (req: Request) => Response | Promise<Response>) =>
  Bun.serve({ hostname: url.hostname, port: Number(url.port || 80), fetch })

const db = openDb(join(config.dataDir, 'studio.sqlite'))
seedTestAccounts(db) // concept only (plan §14)
listen(config.appUrl, createApp({ ...config, db }).fetch)
listen(config.previewUrl, createPreview(config).fetch)
console.log(`app ${config.appUrl.origin}  preview ${config.previewUrl.origin}`)
