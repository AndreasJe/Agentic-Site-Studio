// Dev: both listeners (restarting on change) plus Vite rebuilding the client.
export {}

const run = (cmd: string[]) => Bun.spawn(cmd, { stdout: 'inherit', stderr: 'inherit' })
const procs = [
  run(['bun', '--watch', '--env-file=../../.env', 'server/main.ts']),
  run(['bunx', 'vite', 'build', '--watch']),
]
process.on('SIGINT', () => {
  for (const p of procs) p.kill()
  process.exit(0)
})
await Promise.race(procs.map((p) => p.exited))
for (const p of procs) p.kill()
