# Spike 2 · Inbox and outbox over SFTP

**Time box:** half a day. **Plan:** §13.4, §13.6; decisions #1.

## Question
Can the app run production entirely through two chrooted SFTP folders, with production never connecting to the app?

## Do
1. On a test VM: an SFTP-only user chrooted to `inbox/` (write) and `outbox/` (read), key-only.
2. App pushes a signed bundle; agent verifies signature and hash, unpacks to `releases/<n>/`, switches a symlink atomically.
3. App drops a signed `freeze` command (sequence number + expiry, app signature only) and an `unfreeze` command (Admin passkey).
4. Agent writes `heartbeat.json`, smoke-test results and logs to the outbox; the app reads them and marks production "Unreachable" when the heartbeat is stale.
5. Pairing: app shows its SSH and signing public keys; the Admin installs them; the app pins production's host key.

## Pass when
- Production has no outbound route to the app and still works end to end.
- A replayed or expired command is refused; an unfreeze without a passkey is refused.
- A failing smoke test switches back to the previous release without a new signature and is reported in the outbox.
