
## #48 (M7)

**Transport (M7.2).** `apps/studio/server/transport/`: `Transport` (putInbox, listOutbox, readOutbox, close), `FolderTransport`, `SftpTransport` (ssh2, key-only).
- Names: `[A-Za-z0-9._-]`, one optional subfolder level, no `..`, and `.tmp-` is reserved for the upload temp. The same rule is checked on the client and (as path refusal) on the test server.
- The host key is pinned on first successful sign-in (not at first contact), so a refused key is never pinned. A different key later gives `host-key-changed`; there is no automatic re-pin (re-pairing is a deliberate Admin step, M7.5).
- The app's key is `DATA_DIR/keys/app-ssh-ed25519` (+ `.pub`), mode 0600 where the OS allows. Pins live in a JSON file (`FileHostPins`).
- Upload: `.tmp-<name>` then rename. Plain SFTP rename won't replace, so a re-sent name is unlinked and renamed again (a short gap on a re-send only; release and command names are unique by number).
- One retry, only for connect, timeout and connection-lost errors; never for auth or host-key errors.
- Pending the VM: a real sshd chroot, and "production has no route to the app" (firewall).

**Release bundle (M7.3).** `packages/shared/src/release/bundle.ts`: `writeReleaseBundle`, `verifyBundle`, `listArchive`.
- The bundle is an uncompressed ustar archive with exactly two entries: `release-manifest.json` (canonical JSON) and `site.tar`, the M6 package archive byte for byte.
- The manifest has `project, site, target, revision, validUntil` (#27) plus `packageHash`: `sha256:<hex>` of `site.tar`, which is the M6 package hash (#47). Schema: `docs/pending/contracts/release-manifest.schema.json`.
- Two hashes, not to be confused: `release.json` `packageHash` is still the SHA-256 of the whole bundle file (#23), which the passkey signs with the release number; the manifest's `packageHash` names the package inside it.
- `verifyBundle` (production, after the signatures): exactly those two entries, a valid manifest with the hash, `site.tar` hashing to it, and a strict `site.tar`: the bundle's tar rules (canonical headers, regular files, safe unique paths, two zero blocks) plus limits (10 000 files, 64 MB a file, 512 MB in all), no Windows device names or trailing dots, and no path that is both a file and a folder. The bundle file itself may be at most 600 MB (agent setting).
- `validateManifest` still accepts a manifest without `packageHash` for the old callers; `verifyBundle` requires it.

**Commands (M7.1).** `trust.ts` gains three commands, all under the one sequence counter (#26). Schema: `docs/pending/contracts/command.schema.json`.
- `remove-key` `{ remove: [keyId…] }`: a trust-keys that only removes, under the same key rule (#28, #32).
- `cert` `{ certificate: PEM }` and `csr` `{}`: the app's signature is enough, like freeze (#3); both work while frozen. What a certificate may be is checked by the agent.

**Production agent (M7.1).** `apps/agent` (Bun). `bun src/main.ts run <config.json>`; `bun src/main.ts confirm <config.json> <fingerprint>`.
- **Install config, not from the app:** home, inbox, outbox, the one site it serves (as in the manifest), the DNS names a certificate may carry (default: the site's host; a wildcard only if listed), host and port, keep (default 5), heartbeat (30 s) and poll (2 s) intervals, an optional approved video host for `frame-src`.
- **Inbox (read only):** the app writes `release-<n>.tar` first, then `release-<n>.json`; any other `*.json` is a command; `.tmp-*` names are ignored; anything else is refused as `unknown-file`. The agent never writes, renames or deletes there; the app clears the inbox after reading the results. What has been handled is kept in the state by name, size and time (plus the hash for commands), so an upload is handled once and a re-upload is a new request (replays are refused by number).
- **Order:** each scan handles commands by sequence first, then releases by number, so a freeze that arrives with a release wins.
- **Pairing:** a genesis file is refused as `fingerprint-not-confirmed` with the fingerprint as the detail (in the outbox and on the console) and stays waiting; the person at the server runs `confirm` with it, and the next scan accepts it.
- **A release:** `acceptRelease` (signatures, the rule, the bundle hash, the number, target, validUntil, frozen) → `verifyBundle` → the site must be the agent's → unpack into `releases/.tmp-<n>/` with exclusive creates → rename to `releases/<n>/` → state saved → switch → smoke test → prune.
- **Switch:** the agent's own server serves the active folder named in the state. `current` is a relative symlink renamed over the old one on Linux (atomic); on Windows a junction, moved aside and replaced, and rebuilt from the state at start.
- **Smoke test** after every switch (release and activate), through the running server's own handler in the process (`server.fetch`, no socket): `/` and every `.html` page answer 200 as HTML with the exact package bytes, every security header exact, no cookie.
  - On failure it switches back to the release active before, with no signature (#6), and reports `switched-back`. With nothing before it, the site is taken offline (503) and reports `taken-offline`. The release number stays used.
- **Keep:** the newest K releases plus the active and previous ones. A pruned release is also removed from what `activate` accepts (`unknown-release`); `not-kept` if its folder is missing.
- **Web server:** listed paths only, GET and HEAD, no cookies. The contract CSP with `frame-src 'none'` (or the one configured host) and `frame-ancestors 'none'`; HSTS (one year, no includeSubDomains), Referrer-Policy `strict-origin-when-cross-origin`, a Permissions-Policy that turns off camera, microphone, location, payment, USB, serial and Bluetooth, nosniff, `X-Frame-Options: DENY`, COOP and CORP `same-origin`. Freeze stops changes, not visitors.
- **Certificates:** an ECDSA P-256 key made at first start in `state/tls/key.pem` (0600; never in the outbox); a CSR in `outbox/csr/<host>.pem` at first start and on `csr`. A `cert` is installed only if the leaf's key is the agent's, every SAN is a DNS name it is configured for, it is valid now, and each certificate is signed by the next. The server then restarts with TLS. Renewal is the same step.
- **State:** one `state/state.json`, atomic and fsynced: the trust state (keys, rule, counters #30, highest release and last sequence #34, frozen), active, previous, kept, last smoke test, handled files, installed certificate. One agent per home (a pid lock).
- **Outbox:** `heartbeat.json` (contract fields plus target, site, paired, previous and kept releases, highest release, last sequence, free disk, certificate, tls), `results/<inbox name>` (`.json` added for other names) with `ok` and the refusal `code`, `smoke/<n>.json` with every page checked, `csr/<host>.pem`, and `log.jsonl` (the newest 1000 lines, rewritten atomically). All writes are temp file, fsync, rename.
- **Fail closed:** an unexpected error refuses that inbox item with code `error`; the state on disk is always the last consistent one.
- **Pending (VM):** a read-only inbox mount and an unprivileged user, no outbound route, the agent's own signed updates (§13.6).
