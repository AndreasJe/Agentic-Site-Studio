
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

**Deployment side (M7.5 to M7.7).** `server/deploy/`, `server/mail/`, routes in `server/app/deploy.ts` and `mail.ts`.
- **Pairing** (`pairing.ts`): a wizard, Admin only: keys → connect (host key shown, nothing pinned) → pin-host (the Admin compares; only the key the app saw can be pinned) → prepare → confirm. `prepare` builds the genesis `trust-keys` command (app origin, rpId, target, app signing key, every non-removed Admin passkey, optional rule, `from` = the target's last command and release numbers, #34) and one fingerprint (#31, the same `genesisFingerprint` production computes). `confirm` takes the confirming Admin's passkey assertion over the command's challenge and checks it with `acceptCommand` on an empty state, exactly as production will, before anything is written to the inbox. The person at the server then confirms the fingerprint (#25). A heartbeat saying `paired` makes the app mark the target paired and the keys approved (`markKeysApproved`).
- **Numbers belong to the target** (`deploy_targets.last_sequence/last_release`), not to a host, so re-pairing keeps them. `allocateSequence` is the one command counter (#26). The heartbeat's numbers are never imported (it is untrusted).
- **Host keys:** pinned in `deploy_targets.host_fp`, never as a side effect of connecting. A changed key gives `host-key-changed`; re-pairing is a new `connect`.
- **Certificates** (`certs.ts`): `Issuer` with `TestIssuer` (local CA) and `AcmeIssuer` (acme-client, DNS-01 through an injected `DnsProvider`; tested with a mock client only). A CSR is accepted only if its names are all in the target's list (`deploy_targets.domains`, from the heartbeat's site or the Admin). The app checks the Issuer's answer is for the CSR's key before sending, signs a `cert` command with its own key (no passkey) and writes it to the inbox. Renewal from the stored CSR when two thirds of the validity have passed (day 60 of 90); a failed renewal is retried after an hour; an Admin warning (notification and mail, once) when 14 days or less are left.
- **Mail:** SMTP settings in `settings` (`mail.smtp`), the password AES-256-GCM sealed with a key in `DATA_DIR/keys/secret-box.key` and never returned. Every send attempt is in `mail_log`. Addresses are `users.email`, set by an Admin. Templates (EN and DA): publication requested, release accepted, release refused, smoke switch-back (or offline), certificate expiry, new Admin key. A link is the app's address plus one of `/admin/inbox`, `/admin/deployment`, `/admin/users`, `/admin/mail`, `/admin/review/<revision>`: no query, no fragment, no token (tested for every template). A Creator's note is escaped, links in it are defused. Refusal codes from production are mapped to known wording, never shown raw.
- **Smoke switch-back:** an outbox `smoke` event that failed or switched back adds a "Waiting for you" item and emails every Admin.
- **Address requests:** the Admin's answer is kept in `address_decisions` (saved revisions never change). Requests are read from each project's newest saved revision (a private draft is never read). Approval repeats the M3 name rules (`checkAddressName`, extracted from `requestAddress`, unchanged), and an approved name is reserved across all sites (unique index). Rejecting needs a note.
- **Languages:** `site_languages` per site: enabled (default off), default language, a list of up to 12 two or three letter codes. Non-default languages get `/<code>/`. No hreflang or per-language metadata. Admin changes; members read.

**Release side (M7.3, M7.4).** `server/release/`, `server/governance/`, `server/deploy/outbox.ts`, routes in `server/app/release.ts` and `server/app/governance.ts`.
- **App signing key** (`release/keys.ts`): Ed25519 in `DATA_DIR/keys/app-signing-ed25519.json` (mode 0600; the same file `deploy/app-key.ts` reads), made at first use. `appSigningPublicKey(dataDir)` (raw, base64url), `appSign`, `signAppCommand`. It signs freeze, cert and csr only. The private key never leaves the module.
- **Signing requests** (`signing_requests`, `signing_signatures`):
  - One fixed challenge per release or command. Each Admin signs once.
  - Each assertion is checked in the app with the shared verifier: origin = APP_URL, rpId, UV, and the counter by compare-and-set (#30). It must come from the Admin's own key, and that key must not be removed.
  - Distinct Admins count toward `needed`. A key rule can also name an `owner`, who must be among the signers (#28).
  - Statuses: open → signed → sent → accepted or refused. Also stale (expired, or overtaken by a later number: #26, #30), cancelled, and done (app-only).
- **Release** (`release/release.ts`):
  - **The review shows:** the request, the staged revision and hash, and the note. Then the floor checks of that exact package, and the visual check per page with that page's sections from the revision's own design. The worker stores no screenshots, so it shows findings only. Then the warnings, the acknowledgements and the signers.
  - **Warnings:** every advisory check (and smoke) that did not pass, not-run included. Acknowledging one needs a reason (≤ 500 characters).
  - **The challenge** needs every warning acknowledged and the floor passed. It builds the bundle first:
    - the manifest: project, site (the revision's first address), target `production`, revision, validUntil (now + 7 days − 1 hour) and packageHash;
    - then site.tar, the M6 archive, checked against the request's hash.

    It stores the bundle as a blob and takes the next release number from `deploy_targets.last_release`. The options it returns have exactly `releaseChallenge(bundleHash, n)` as their challenge. A second Admin signs the same bundle and number.
  - **Delivery:** when the rule is met, `release-<n>.tar` and then `release-<n>.json` go to the inbox (the contract shape; `approvedBy` = the signers).
  - **Requests:** a newer request supersedes an older one, and the old signatures are never sent. Send back needs a note (≤ 2000 characters) and closes the request (`sent-back`). Once production accepts, the request is `published`.
- **Commands** (`release/commands.ts`):
  - One sequence counter per target (`allocateSequence`). Each command expires 24 hours − 1 minute after it is made.
  - Freeze is signed by the app key alone and sent at once.
  - Unfreeze and activate need one Admin's passkey (plan §13.9: rollback and freezing need one Admin).
  - trust-keys (rule, keys) and remove-key follow the key rule.
  - Before anything is sent: a command or release whose number is not above the highest this app has already sent is stale and must be signed again. Sending one marks older unsent ones stale (#26).
- **Outbox poller** (`deploy/outbox.ts`): `pollOutbox(ctx, target, t)`, `onOutbox(fn)`, `pollAll(ctx)`, `lastHeartbeat`, `startOutboxPolling`.
  - **What it reads:** only `heartbeat.json`, `results/*`, `smoke/<n>.json` and `csr/<host>.pem`, at most 2000 names a poll.
  - **Size caps:** 64 KB for a heartbeat or result, 1 MB for a smoke file, 16 KB for a CSR.
  - **Parsing:** known fields only. A result must name its own file, and a code must be `[a-z0-9-]{1,64}`. A smoke file must carry its own number, and a CSR must be a PEM block.
  - **Anything else** is skipped and remembered by its digest, so each version of a file is reported once.
  - **Only the first result** for something the app sent changes its status. A later one is a re-upload the app did not make, so it adds an "outbox-refusal" item instead.
  - **Codes** are mapped to a known list; anything else shows as "other".
- **Waiting for you** (`release/inbox.ts`, re-exported from `deploy/outbox.ts`):
  - The `inbox_items` table and `notify(ctx, kind, ref, title)`. An open item with the same kind and ref is never added twice. An item is closed by hand, or when it has been dealt with.
  - Kinds from this side: publication-request, release-accepted, release-refused, command-refused, outbox-refusal, admin-key-added.
  - A release accepted or refused, and a new Admin key, also send mail to every Admin (`mailAdmins`).
- **Governance** (`governance/policy.ts`, `change.ts`):
  - **Presets:** Small team {1,1,1} (the default), Standard {releases 1, keys 2, domains 2}, Strict {2,2,2}. A rule that matches none shows as "custom".
  - **A change** is a trust-keys `{policy}` command. It needs `max(current keys, the current number of every part that is lowered)` Admins, the same rule production applies.
  - **When it counts:** a raise counts in the app at once (stricter is safe). A lowering counts only once production has accepted it.
  - **Before pairing:** with no target paired, the change is app-only, with a `stp1` challenge and the same count.
  - One open change at a time. Every change is in `audit_log`.
- **Keys** (`governance/keys.ts`):
  - **The list** shows each key as waiting, approved or removed.
  - **Your own new device:** register it (`/api/admin/keys/register/options`, then `/register`); it then waits for approval. Approval is a trust-keys `{add}` under the key rule, and the owner's own existing key must be among the signers (#28).
  - **A key for a new Admin** (one with no other key) needs as many other Admins as the strictest rule. A new key never signs its own approval.
  - **Removing a key** is a remove-key command under the key rule. It is refused if it would leave fewer Admins than the strictest rule needs.
  - **A removed key** is marked removed at once: it signs nothing and can't sign in. Its row stays, so neither the credential nor the key material can be registered again (#32).
  - The pairing file uses the user handle as the Admin id.
- **Audit log** (`audit_log`): append-only. A trigger refuses every update and delete.
- **Check-settings step-up** (`governance/stepup.ts`):
  - Lowering a check level (block → warn or off, warn → off) answers 428 `step-up-required` with WebAuthn request options. The client signs them and sends the same change again with `stepUp: {id, rawId, response}`.
  - **The challenge** is ASCII `stp1` ‖ SHA-256 of the canonical JSON of `{action: "check-level", check, from, to, by, nonce, expires}`: 36 bytes.
  - The ceremony is stored on the server, lives 2 minutes and can be used once. It is bound to the Admin and to that exact change.
  - The `stp1` tag keeps it apart from `cmd1` commands (#24). Its length keeps it apart from sign-in challenges (32 bytes) and release challenges (40 bytes).
  - Raising a level needs no step-up.
- **Migration:**
  - `publication_requests` is rebuilt with the statuses open, superseded, sent-back and published, plus the closing fields.
  - `passkeys` gains `approved_at` and `removed_at`.
  - New tables: `audit_log` (with its triggers), `signing_requests`, `signing_signatures`, `review_acknowledgements`, `ceremonies`, `inbox_items` and `outbox_seen`.
- **Approved keys** (after the security review):
  - Only approved keys sign anything: releases, commands, governance changes and step-ups.
  - A key set up with a setup code is approved at once while no target is paired; it is part of the install's root of trust. After pairing, a new Admin's key waits for approval.
  - ~~Pairing marks the keys in its file as approved.~~ Replaced by the second review below: only keys already approved go into a pairing file, and nothing from the outbox approves a key.
  - Adding your own device starts with a step-up by one of your approved keys, so a stolen session can't add a device of its own.
  - Any change to the rule makes every other request that is still waiting for signatures stale.
  - A signature moves a request to `signed` only from `open`, in one transaction.
  - The floor checks and the acknowledgements are checked again when a release is sent.
- **Second security review (M7 findings 1 to 8):**
  - **The genesis carries the app's current rule** (`currentPolicy`), always written into the file. A `policy` in the prepare request that differs from it is refused (409 `policy-mismatch`); the rule is changed in governance, never by pairing. Too few Admins with approved keys for the strictest part: 409 `too-few-admins`.
  - **Only approved keys that aren't removed** enter a pairing file, and the confirming key must still be approved and not removed at confirm. The heartbeat saying "paired" changes the status shown and nothing else (no key approval).
  - **Certificate names come only from the Admin** (`domains` is required at connect, 400 `domains-required`), never from the heartbeat's `site`. Deriving them from `address_decisions` is not built (those hold sub-labels, not full names, and no project-to-target link exists). certs.ts still refuses a CSR name outside the target's list.
  - **Outbox reads are capped by the transport:** `readOutbox(name, maxBytes)`. Folder: open, fstat, refuse over the cap before reading, then a read loop to cap+1. SFTP: open, fstat, the same loop (so a server that lies about the size is still stopped one byte past the cap). Over the cap: `TransportError('too-large')`. The poller remembers an oversize file as `oversize` and never reads it in full.
  - **Re-pairing keeps the live pairing:** connect on a sent or paired target writes a candidate (`deploy_candidates`); pin and prepare work on it; confirm sends the genesis to the candidate's host and only then switches the target to it. Freeze and every other command reach the live host until then. `TargetView.candidate` shows the re-pairing; the top-level fields stay the live pairing. Prepare on a live target with no candidate is refused (`already-paired`), also when it is only sent.
  - **Lowering the rule and approving a key count on delivery** (`applySigned`): the signatures already met the current rule. An outbox `ok` result only moves the status and the notifications (and a release's request to published); it changes no rule and no key. If production then refuses, the app shows the refusal; it does not undo the change.
  - **The agent reads inbox files without following links:** lstat and `isFile()` first, open with `O_NOFOLLOW` where the platform has it, fstat on the descriptor, read only that size, capped. A symlinked command is ignored; a bundle that isn't a regular file is refused (`unknown-file`).
  - **Cert commands go through `sendAppCommand`:** one counter, a signing row, and older unsent commands marked to be signed again (#26). The cert command now lives 24 hours less a minute, like other commands (it was one hour).
  - **`deliverRelease` checks again that every signer's key is approved and not removed**; if one is not, the release goes stale (`key-removed`) and has to be signed again.
- **Review fixes, 22 Oct (M7):**
  - **Confirm re-checks the pairing file against now.** `confirmPairing` runs the approved, not-removed Admin key query and `currentPolicy` again. If the key ids (same order) or the rule differ from what prepare put in the file, it answers 409 `needs-re-preparing` and sends nothing; preparing again makes a fresh file. The confirming key's own check (`wrong-key`) comes first.
  - **A key removal counts in the app once it is signed, before delivery.** The key is marked removed (and audited once) when the last signature is in, so a failed upload never leaves it signing or counting. If the upload fails, "deliver" retries the same signed command. If that command goes stale (expired, overtaken) or production refuses it, a new removal for the already-removed key may be started; it is refused (`key-removed`) only once a removal is signed, sent, accepted or done (or no target is paired).

## #49 (M8): models, usage, backups, setup (server)
- **Endpoints** are in `model_endpoints` (keys sealed with the mail module's AES-256-GCM box, never returned; `keySet` only). **Roles:** writer, sorter, critic, analyst, design, suggestions, in `model_roles`.
- **Lookup:** `endpointFor(ctx, role, fallback)`: the mapped endpoint; else the first endpoint an Admin added; else the `.env` endpoint. Callers: brief and structure use sorter, design uses design, checkmark suggestions use suggestions, the failure analyst uses analyst. The critic and writer roles have no caller yet. `usage.model_role` values written by callers (planner, designer) are unchanged.
- **Test connection** tries json_schema, then json_object, then none (a 400/422 or a non-matching reply moves down; 401, 5xx or no connection stops). An explicit capability is an Admin override and survives later tests.
- **Usage:** `usage_daily` holds per-project daily totals. The retention job (setting `usage_retention_days`, default 90, run hourly from main.ts and by an Admin button) folds per-person rows (rows with a user) into it, then deletes them. Per-person figures: `/api/usage/person/:handle`, 403 for anyone but that person and Admins.
- **Backups:** target folder must be absolute and outside DATA_DIR; restore goes to a new absolute folder outside DATA_DIR. The timer runs hourly and needs `BACKUP_PASSPHRASE` in the environment; without it scheduled backups do not run. A failed run adds a `backup-failed` inbox item.
- **Project settings** (`settings` key `project.<id>.settings`): members, structureNeedsAdmin, two-person rule and check levels, stricter than the install only.

- **Review fixes, 22 Oct (M8, #49):**
  - **SVG stripping is one indexOf scan per pass** (at most 20 passes, each linear). A `<!--` without `-->`, or a `<metadata>` (any prefix, any case) without its end tag or without `>`, is refused at once. A name whose local part starts with `metadata` and a non-word character (`metadata-x`) is refused, as before.
  - **JPEG stripping walks the entropy-coded data.** FF00 and RSTn are data; any other marker starts a segment with the same drop rule (APP1, APP13, COM, and APP2 when it is `MPF\0`; ICC_PROFILE stays). The output ends at the first EOI; everything after it is dropped (MPF secondary images, appended previews). A file no longer has to end in FFD9 to be accepted, only to reach an EOI.
  - **Reserved project IDs.** `DATA_DIR_ENTRIES` in `server/store/revisions.ts` is the one list of top-level names in DATA_DIR: keys, media, brand, checks, studio.sqlite (-wal, -shm), blobs, packages, backups, deploy, release-log, releaselog, releases. `RESERVED_PROJECT_IDS` (each name's slug, the database by its base name `studio`) is refused at creation as `slug-taken` with `reserved: true` and a suggestion (`keys2`). Backup's `TOP_LEVEL_EXCLUDED` is the entries marked `backup: false` (checks and the database files), so keys, media and brand still travel with a whole-instance backup. A project-scope backup of a reserved ID is refused.
  - **Model endpoints.** Changing the base URL's origin clears the sealed key unless a new key comes in the same request. Test connection refuses loopback (127/8, ::1, localhost, *.localhost), 0.0.0.0/8, link-local (169.254/16, fe80::/10), 169.254.169.254, fd00:ec2::254, 100.100.100.200, IPv4-mapped/compatible and NAT64 forms of those, and metadata names (metadata, metadata.google.internal, metadata.goog, instance-data[.ec2.internal]); for other names it checks what DNS gives now. The `.env` endpoint's origin is allowed. Tests pass `createApp({ testOnly: { localModelHosts: true } })`. Test connection calls with `redirect: 'error'` (a new optional `LlmInput.redirect`; other calls still follow redirects). The result carries `status` and `refused`; `error` is written from the status, never the reply's bytes, and that is also what is stored.

