import { createApp } from './app/index.ts'
import { loadConfig } from './config.ts'
import { createPreview } from './preview/index.ts'

const config = loadConfig()
if (config.instanceIdGenerated) {
  console.log(`INSTANCE_ID not set; generated ${config.instanceId}. Set it in .env to keep it.`)
}

const listen = (url: URL, fetch: (req: Request) => Response | Promise<Response>) =>
  Bun.serve({ hostname: url.hostname, port: Number(url.port || 80), fetch })

listen(config.appUrl, createApp(config).fetch)
listen(config.previewUrl, createPreview(config).fetch)
console.log(`app ${config.appUrl.origin}  preview ${config.previewUrl.origin}`)
