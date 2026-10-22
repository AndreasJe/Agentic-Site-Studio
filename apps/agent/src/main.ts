// The production agent's command line, for the person at the server:
//
//   bun src/main.ts run     <config.json>                  watch the inbox, serve the site
//   bun src/main.ts confirm <config.json> <fingerprint>    confirm the pairing fingerprint
//
// The config file is written at install: { "home", "site", "inbox"?, "outbox"?, "domains"?,
// "hostname"?, "port"?, "keep"?, "heartbeatMs"?, "pollMs"?, "frameSrc"? }.
import { Agent } from './agent.ts'
import { loadConfig } from './config.ts'

const [verb, file, arg] = process.argv.slice(2)
if (!file || (verb !== 'run' && verb !== 'confirm')) {
  console.error('usage: bun src/main.ts run <config.json> | confirm <config.json> <fingerprint>')
  process.exit(2)
}
const agent = new Agent(loadConfig(file))
if (verb === 'confirm') {
  if (!arg) {
    console.error('usage: bun src/main.ts confirm <config.json> <fingerprint>')
    process.exit(2)
  }
  // The running agent picks it up on its next look at the inbox.
  agent.confirmFingerprint(arg)
  console.log('CONFIRMED')
} else {
  await agent.start()
  const stop = async () => {
    await agent.stop()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}
