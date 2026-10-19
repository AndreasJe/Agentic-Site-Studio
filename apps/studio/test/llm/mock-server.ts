export type Reply =
  | { kind: 'content'; content: string; usage?: boolean }
  | { kind: 'status'; status: number }

// Replies are consumed in order; the last one repeats.
export function mockServer(script: Reply[]) {
  const bodies: Record<string, unknown>[] = []
  let i = 0
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname !== '/v1/chat/completions') {
        return new Response('no', { status: 404 })
      }
      bodies.push((await req.json()) as Record<string, unknown>)
      const reply = script[Math.min(i++, script.length - 1)]
      if (!reply) return new Response('empty script', { status: 500 })
      if (reply.kind === 'status') return new Response('boom', { status: reply.status })
      const chunk = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`
      const half = Math.ceil(reply.content.length / 2)
      let body = ''
      for (const part of [reply.content.slice(0, half), reply.content.slice(half)]) {
        body += chunk({ choices: [{ delta: { content: part } }] })
      }
      if (reply.usage !== false) {
        body += chunk({
          choices: [],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            prompt_tokens_details: { cached_tokens: 7 },
          },
        })
      }
      body += 'data: [DONE]\n\n'
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  return { baseUrl: `http://localhost:${server.port}/v1`, bodies, stop: () => server.stop(true) }
}
