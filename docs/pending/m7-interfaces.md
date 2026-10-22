# M7 interfaces (shared by the release agent and the deployment agent; overnight)

## Ownership
- **Release agent (Opus):**
  - `apps/studio/server/release/` and `server/app/release.ts`.
  - The outbox poller, `server/deploy/outbox.ts`.
  - Governance and keys: `server/governance/` and `server/app/governance.ts`.
- **Deployment agent (Sonnet):**
  - pairing (`server/deploy/pairing.ts`);
  - certificates (`server/deploy/certs.ts`);
  - mail (`server/mail/`);
  - address-request approval;
  - languages;
  - routes in `server/app/deploy.ts` and `server/app/mail.ts`.
- **Migrations:** each agent appends ONE migration at the end of the array in `server/db/index.ts`, right before it finishes. It re-reads the file first, so neither agent hard-codes a number. `test/store.test.ts` is changed to expect the array length (export it as `MIGRATIONS`) instead of a literal.
- **Mounting:** both mount their routes with one line each in `server/app/index.ts`.

## Transport
`server/transport/` is built: `Transport` (`putInbox`, `listOutbox`, `readOutbox`, `close`), `FolderTransport`, `SftpTransport`. One transport per paired target; the deployment agent's pairing module provides `transportFor(ctx, target): Transport | null`. Until pairing exists, the release agent uses a `FolderTransport` from config in tests.

## Outbox poller (release agent implements, deployment agent consumes)
```ts
// server/deploy/outbox.ts
export type OutboxEvent =
  | { kind: 'heartbeat'; target: string; at: string; body: unknown }
  | { kind: 'result'; target: string; name: string; ok: boolean; code?: string; body: unknown }
  | { kind: 'smoke'; target: string; release: number; ok: boolean; switchedBack: boolean; body: unknown }
  | { kind: 'csr'; target: string; host: string; pem: string }
export function pollOutbox(ctx: StoreContext, target: string, t: Transport): Promise<OutboxEvent[]>
export function onOutbox(fn: (e: OutboxEvent) => void | Promise<void>): void   // subscribers
```
- It only reports new items: it keeps the last-seen state per target in SQLite.
- **Production's outbox is untrusted data.** Parse it with schema checks and caps, and never act on a code or text from it beyond showing it and mapping known refusal codes.

## Notifications ("Waiting for you")
- The release agent owns an `inbox_items` table (id, kind, ref, title, created_at, done_at) and `notify(ctx, kind, ref, title)`.
- The deployment agent calls `notify()` and sends mail for switch-back and certificate expiry.
- **No mail ever contains a link that performs an action.** Mail links point to pages only.
