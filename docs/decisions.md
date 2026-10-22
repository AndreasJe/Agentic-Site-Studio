# Developer decisions (19 Oct 2026)

The developers' answers to the feasibility review. These override anything older in `plan.md`. Section references (§) point into `plan.md`.

**Infrastructure / DevOps**

1. **Release flow.** Production never connects to the app. The app connects over SFTP with its own key to two chrooted folders: an **inbox** (signed bundles, certificates, signed commands with sequence number and expiry) and an **outbox** (heartbeat, disk use, active release, smoke-test results, logs, certificate requests). Freeze needs only the app's signature; unfreeze needs an Admin passkey. Health comes from the heartbeat's age. Pairing installs the app's SSH and signing public keys on production and pins production's host key (trust on first use).
2. **Check runner sizing.** A separate worker on Node and Playwright; 2–3 GB disk for browsers, 2–4 GB RAM per concurrent check; a queue with concurrency 1–2.
3. **Certificates.** Issued before go-live. Production makes its own key and writes a CSR to the outbox; the app runs ACME with DNS-01 and drops the certificate in the inbox, outside any release. Renewal around day 60 of 90, no passkey. Fallback: key encrypted to production's public key. One wildcard per environment; campaign domains are public in CT logs.

**Security and identity**

4. **Preview isolation.** App and previews on different sites (`studio.internal`, `preview.internal`), not sibling subdomains or ports. Origin check and CSRF token on every state-changing request; previews get `connect-src 'self'` and no cookies.
5. **CSP contract** as in §21.1, with one approved video platform per site in `frame-src`, external scripts only, and a check-runner rule: zero CSP violations in the console.
6. **Passkey-signed releases.** Signature over release hash plus an ever-increasing release number (guards acceptance, not the active release). Automatic switch-back without a new signature; Admin rollback is a new signed release pointing to old content. Origin and user verification checked; a signature counter of 0 is ignored.

**Frontend and the design engine**

7. **Section markers.** `data-section="<stable-id>"` in shipped HTML, unique per page, kept in production.
8. **Byte-identical package.** Built once, one SHA-256; preview, staging and production serve it unchanged. Review shell on the preview origin with overlays from the markers; approval in the app from the app's own data. Accepted risk: the shell shares an origin with generated code.
9. **Multilingual, no SEO.** Site settings › Languages, off by default; subpaths per language; no hreflang, per-language metadata or sitemaps; menu labels per language; Translated is a completeness check only.
10. **Concurrent editing.** Private drafts, autosaved; a numbered revision only on save; Bring from as the merge tool; presence shown in the Design editor and Revisions; no locks, no Replace.

**Validators and checks**

11. **Throttled GPU motion test:** removed.
12. **3D and heavy-animation profile** (§8.1).
13. **Validator scope:** DOM text and CSS colours and fonts; canvas/WebGL, images and video on a manual checklist; text over images as a warning-only heuristic.
14. **Derived colours in OKLab** with one shared module and golden test vectors; mismatches signed off by design (accept or pin the old hex).
15. **Screenshot comparisons** with reduced motion, animations off, videos at frame 0, fixed seeds and masked canvases; generated code must honour reduced motion (validator rule).
16. **3D interactions** expose DOM controls, which the interaction check tests.
17. **Field speed data** is optional; lab results are the gate.

**AI and models**

18. **Structured output:** capability flag per provider, schema validation with two retries, usage via `stream_options.include_usage` or a marked estimate.
19. **Critic on large sites:** a generated site digest plus the full content of only the pages under review.
20. **Token estimates** as calibrated low–high ranges, with actuals after.
21. **Self-healing** as in §13.5: untrusted, redacted logs; no tools; fixed output schema; cost cap; at most two attempts.

**Compliance**

22. **Personal data:** usage per site and project by default; per-person usage only for that person and Admins, aggregated and deleted after a fixed period; check the Danish rules on control measures with HR; metadata stripped from images, PDFs and video.

**Priority.** Before the build starts: 4, 7, 8, 10, 14, 18, and the written policy in 5 (enforcement later). Production stage: 1, 3, 6, 12, 17, 21, 22.

## Answers from the first planning session (19 Oct 2026)

Questions A1–A4 from the planning session, answered by the product owner.

23. **Release challenge (A1).** The package hash is the SHA-256 of the bundle archive file, checked before unpacking. The release challenge is that raw 32-byte hash followed by the release number as an unsigned 64-bit big-endian integer: 40 bytes, given to WebAuthn as raw bytes.
24. **Signing threat model (A2).** Passkey signing protects production against stolen sessions, Creators and the AI. It does not protect against a taken-over app server, which can show misleading text and choose what the passkey signs; §13.4 and §13.9 are narrowed to match. Every kind of challenge has its own fixed format, so one can never pass as another:
    - a sign-in challenge is 32 fresh random bytes;
    - a release challenge is the 40 bytes of #23;
    - a command challenge is the four ASCII bytes `cmd1` followed by the 32-byte hash of #26 (36 bytes).
25. **First trusted keys (A3).** At pairing, the first keys reach production as a `trust-keys` command signed by the confirming Admin's passkey, whose key is in the file. The agent shows the key fingerprints, and the person at the server compares them before it is accepted (trust on first use). Later key changes must be signed by keys production already trusts, per the two-person rule.
26. **Command signatures (A4).** Commands carry a `signatures[]` list, like `release.json`. A passkey signature carries the full assertion (`adminKeyId`, `authenticatorData`, `clientDataJSON`, `signature`), so two Admins can sign `trust-keys`. The signed hash is SHA-256 over the command without `signatures`, serialised as canonical JSON (RFC 8785, integers only). One sequence counter per target covers all commands. A freeze issued in the meantime means an older, unsent unfreeze has to be signed again.

## Answers after the spike 1 security reviews (19 Oct 2026)

27. **Release manifest.** The bundle carries `release-manifest.json` with `project`, `site`, `target`, `revision` and `validUntil` (`contracts/release-manifest.schema.json`). The bundle hash covers it, so #23 is unchanged. Production acts only on the manifest: the target must be its own, and `release.json` must agree with it. The bundle is an uncompressed tar archive with the manifest as its first entry.
28. **Who can add Admin keys.** An Admin can add keys for themselves (a new phone, a password manager), signed by one of their own keys, under the normal key rule. A key for a new Admin needs as many different Admins as the strictest rule (releases, keys or domains), so no two-Admin rule can be bypassed by inventing a second Admin.
29. **Lifetimes.** Production refuses a command that expires more than 24 hours ahead, and a release whose manifest is valid for more than 7 days ahead or has expired.
30. **Counters during long waits.** Production keeps refusing a passkey counter that went backwards. If an Admin's later signature overtakes a pending one, the app sees the refusal in the outbox and asks for that signature again.
31. **One pairing fingerprint.** The pairing file carries the app's address, rpId, target and signing key along with the Admin keys and the rule. The person at the server compares one fingerprint over all of it; nothing is typed in by hand.
32. **Removed keys stay removed.** Production keeps the keys it has removed and refuses to trust them again. A recovered device gets a new passkey.
33. **What freeze stops.** While frozen, production accepts no release and no `activate`. Key changes and unfreeze still work, so a stolen key can be removed during an incident.
34. **Re-pairing a host.** The pairing file carries the target's last command and release numbers, covered by the fingerprint. A replacement host starts from there, so signed files from the old host stay refused.
36. **Structured-output capability (A8).** The flag (`json_schema` / `json_object` / `none`) is set per endpoint and model, detected by "Test connection", with an Admin override. The model is sent a strict-mode-safe schema derived from the contract; the reply is always validated locally against the full contract.
37. **Brief sorting output (A9).** A separate contract, `contracts/brief-sort.schema.json`: blocks with sources, plus the sentences that were left out. Sorted notes get `source.kind: "user"` with `aiSorted: true`.

38. **Framing on the preview address (A5).** The CSP is an HTTP header, never in the package. Preview and staging send the contract CSP with `frame-ancestors 'self' <APP_URL>`, so the review shell can frame the package and the app can frame the shell. Production keeps `frame-ancestors 'none'`.
39. **Relative links only (A6).** Every link and asset path in a package is relative, so one package works under any path prefix (`/r/<rev>/`, `/staging/<site>/`, live subpaths). The validator rejects root-relative and absolute same-site URLs.
40. **LAN reach (A7).** Generated code must not make requests to other hosts: fetch, forms, images, scripts, sockets (CSP, plus a validator ban on `RTCPeerConnection`). Top-level navigation and `window.open` to another host can't be blocked by CSP and are an accepted risk.

41. **M1 defaults (B1–B14), accepted with the M1 plan:**
    - Current is the newest revision, and new drafts start from it; a second saver from an older base is warned and pointed to Bring from.
    - One draft per person per project. After saving, the draft continues from the new revision; discarding asks for confirmation.
    - `name`, `home`, `approved`, `archived` and the next artboard letter live in the SQLite projects table. `project.json` is rebuilt from revisions plus that row. The instance ID is `INSTANCE_ID` in `.env`.
    - The Revisions screen has everything except section-level Bring from and presence (M4).
    - Usage: one row per HTTP attempt with a call ID; `outcome` starts as `pending`; `revision` is the draft's base.
    - Whoever creates a project becomes a member.
    - Sign-out in an avatar menu; sessions last 12 hours with a 2-hour idle limit.
    - One setup code per test Admin.
    - The handle is the user name, letters only.
    - The EN/DA switch is on sign-in and in the avatar menu, saved per person.
    - Menu items for screens that don't exist yet are hidden; Admins land on Projects until M7.
    - One model endpoint in `.env` until M8.
    - Revision phases use the schema's five values.

42. **M2 defaults (M2.1–M2.10), accepted with the M2 plan:**
    - Handles never change. An imported brief keeps its ID if it's free for that author.
    - Round-trip is byte-identical against Bjarke's fixtures. Tone and feel is a normal block.
    - Brief approval is install-wide (Off / Optional / Required, default Optional). An edit after approval returns the brief to draft. Open questions never block.
    - "Partly set" is derived, not stored.
    - One source label per field. An AI block without a source is dropped and becomes "Not set yet."
    - A call to action can be saved without a target. A target is a page ID or an https URL. Only one primary.
    - AI actions stream with a counter and Stop; Stop also cancels the remaining retries.
    - With no history, the token estimate comes from the input size.
    - The injection test covers both the prompt builder and model output.
    - PDF metadata is stripped on upload in M2; images and video follow in M8.
    - Material in M2: text, Markdown and PDF. AI actions are tested against the mock until an endpoint is set.

43. **Who approves a brief.** A project member with the approve right or an Admin; under the Small team preset that is every Creator until Governance arrives (M7). Who approved and when is recorded.

44. **M3 defaults (M3.1–M3.9), accepted with the M3 plan:**
    - `structure.json` sits in the draft with `contracts/structure.schema.json`. Page IDs are stable slugs. Each address is a root.
    - Menu items are pages on the same address plus https links; limits per level come from the navigation pattern.
    - Menus are data in M3; the designed header fills them on export.
    - Redirects live in `structure.json`, added when a page from an approved revision moves.
    - Reachable means through menus or breadcrumbs. The checks run in the app now and again in the check runner in M6.
    - Statuses are Decided, Proposed (AI, accepted one by one or all) and Added later. Moving works by drag and drop plus keyboard buttons.
    - Slugs and address names are lower-case letters, digits and hyphens; `www`, `api`, `admin`, `preview`, `staging` and `studio` are reserved.
    - The mini-brief is fields on the page; a campaign needs an expiry, and expiry gives a warning only.
    - "Pages and their jobs" is generated from the tree.
    - Address requests: the Creator side in M3, the Admin approval screen in M7.

45. **M4 defaults (M4.1–M4.13), accepted with the M4 plan:**
    - Design metadata lives in SQLite: artboards, roles, sections, checklist, takes and deviations.
      - One Lead per page is a partial unique index.
      - HTML and CSS are immutable blobs.
      - Saving a revision writes `design.json`, which maps artboards to blob hashes.
    - IDs:
      - artboards take the project's next letter;
      - section IDs are `s-` plus 6 characters, chosen by code, never by the AI.
    - Takes are previewed from the preview host with the contract CSP. Section labels are an app overlay.
    - The code validator checks static HTML and CSS:
      - the first font family must be in the guide;
      - every colour, normalised, must be a guide or derived colour;
      - relative links only, and no LAN APIs;
      - forms never post;
      - animation needs a reduced-motion rule.
      - The security-floor rules always refuse.
    - Guide versions are install-wide and write-once. Derived hexes are recomputed; a mismatch is refused unless pinned. Rollback is a new version.
    - Follow the site and Explore feed validator errors back through the retries. Think new turns guide breaks into deviations and always makes a new Alternative.
    - An artboard with unsettled deviations can't be Lead. Think new resets after each generation.
    - The header and footer are locked partials from Brand assets.
    - The checklist has 7 items:
      - Interactions needs zero open questions;
      - Mobile needs a mobile variant;
      - Translated is not needed while languages are off;
      - Tested is set by hand until M6.
      - An approved section is locked.
    - Deferred: the critic and digest, logo exports, video, AI alt text, image metadata stripping (M8), the script pause control, and AI instructions per phase.

46. **M5 defaults (M5.1–M5.7), accepted with the M5 plan:**
    - **What is reviewed:** a saved revision's **review package**, built once and stored write-once as `packages/<rev>.json`, with path → blob hash for each page's Lead HTML and its `style.css`.
      - Its hash is SHA-256 over the sorted JSON manifest of [path, blob hash]. This replaces spike 3's `path\0bytes\0` framing, which could be ambiguous.
      - M6 decides how this relates to the bundle archive hash (#23).
    - **Serving:**
      - The shell is at `/__review/<token>/` and the package files are at `/r/<token>/<path>`, on the preview site only, listed paths only.
      - The token is HMAC-signed for project, revision and package hash, valid for 15 minutes.
      - The package frame is sandboxed (`allow-same-origin` only), so a package runs no script in review. Revisit this when site scripts arrive.
      - Package bytes keep `frame-ancestors 'self' <app>`, because the check covers every ancestor.
    - **The app's own CSP:** `script-src 'self'`, `frame-src` pinned to the two preview shell paths, `frame-ancestors 'none'`.
    - **Shell messages:** they change only the selection and the findings shown; they never tick, approve or navigate.
    - **AI checkmark suggestions:** shown, never stored, never applied.
    - **Accessibility findings:**
      - Axe runs in the shell, for display only.
      - Acceptances need a reason and an axe rule id.
      - M6 applies acceptances to axe findings only, never to a security-floor check.
    - **Approve revision:**
      - Every page in the revision has a Lead and every section of every Lead is approved, read from the revision itself.
      - Approval records the hash the app computed.
      - The project's approved revision only moves forward.
      - Who may approve follows decision #43.
    - **Deferred:**
      - Share preview;
      - the CSP-off attack run;
      - the TLS run on the test VM.

47. **M6 defaults (M6.1–M6.8), accepted with the M6 plan:**
    - **Build once:** each revision is built once.
      - Steps: partials and menu, minify, hashed CSS names, sitemap and robots, relative links.
      - The result is a deterministic ustar archive. The package hash is the SHA-256 of that archive, replacing #46's content hash.
      - Review, approval, staging and the release candidate carry this one hash.
      - M7 decides how the release bundle (#27) wraps it; its manifest names the package hash.
    - **The worker** is `apps/worker`, a Node process. It takes jobs from `DATA_DIR/checks/` (pending, running, results) as in `docs/m6-interfaces.md`, and checks the archive hash (and the baseline's) before unpacking.
    - **Floor checks**, always Block: html, links, csp, inline-code, validators, svg, pinned, secrets.
      - Validators fail only on floor issues; guide breaks are deviations and don't block.
      - The secrets scan is regex-based until gitleaks runs on the VM. A file too large to scan is a finding.
    - **Check settings:** every check defaults to Block. Off and Warn are Admin only and audited; the passkey step-up comes with M7.
    - **Staging:**
      - The newest approved revision whose floor checks pass is staged, then a smoke job runs.
      - It is served at `/staging/<signed>/` on the preview site, with its own key label.
      - The Staging screen frames it sandboxed (`allow-same-origin`).
    - **Publication requests:** a plain-text note; a new request supersedes older open ones in one transaction. Admin approval comes in M7.
    - **The analyst:** an `llm()` call with the analyst role and `failure-analysis.schema.json`, no tools, and `max_tokens`.
      - **Input:** redacted, covering at least every secret format the worker flags. Files the secrets check named are left out.
      - **Rules in code:** let-through on any floor failure (fail-closed) becomes hold; a patch must pass `validateDesign` and stay in the project; two analyses per lineage, reserved before the model call.
      - **Send fix** makes a take, never a revision.
    - **Pending:** speed (sitespeed.io, needs approval); the AI code review; worker sizing, Linux screenshots, gitleaks and the worker's own host (VM); the passkey step-up for settings, the Admin inbox and mail (M7).

48. **M7 defaults (M7.1–M7.8), accepted with the overnight plan of 22 Oct:**
    **Transport (M7.2).** `apps/studio/server/transport/`: `Transport` (putInbox, listOutbox, readOutbox, close), `FolderTransport`, `SftpTransport` (ssh2, key-only).
    - Names: `[A-Za-z0-9._-]`, one optional subfolder level, no `..`, and `.tmp-` is reserved for the upload temp. The same rule is checked on the client and (as path refusal) on the test server.
    - The host key is pinned on first successful sign-in (not at first contact), so a refused key is never pinned. A different key later gives `host-key-changed`; there is no automatic re-pin (re-pairing is a deliberate Admin step, M7.5).
    - The app's key is `DATA_DIR/keys/app-ssh-ed25519` (+ `.pub`), mode 0600 where the OS allows. Pins live in a JSON file (`FileHostPins`).
    - Upload: `.tmp-<name>` then rename. Plain SFTP rename won't replace, so a re-sent name is unlinked and renamed again (a short gap on a re-send only; release and command names are unique by number).
    - One retry, only for connect, timeout and connection-lost errors; never for auth or host-key errors.
    - Pending the VM: a real sshd chroot, and "production has no route to the app" (firewall).

    **Release bundle (M7.3).** `packages/shared/src/release/bundle.ts`: `writeReleaseBundle`, `verifyBundle`, `listArchive`.
    - The bundle is an uncompressed ustar archive with exactly two entries: `release-manifest.json` (canonical JSON) and `site.tar`, the M6 package archive byte for byte.
    - The manifest has `project, site, target, revision, validUntil` (#27) plus `packageHash`: `sha256:<hex>` of `site.tar`, which is the M6 package hash (#47). Schema: `contracts/release-manifest.schema.json`.
    - Two hashes, not to be confused: `release.json` `packageHash` is still the SHA-256 of the whole bundle file (#23), which the passkey signs with the release number; the manifest's `packageHash` names the package inside it.
    - `verifyBundle` (production, after the signatures): exactly those two entries, a valid manifest with the hash, `site.tar` hashing to it, and a strict `site.tar`: the bundle's tar rules (canonical headers, regular files, safe unique paths, two zero blocks) plus limits (10 000 files, 64 MB a file, 512 MB in all), no Windows device names or trailing dots, and no path that is both a file and a folder. The bundle file itself may be at most 600 MB (agent setting).
    - `validateManifest` still accepts a manifest without `packageHash` for the old callers; `verifyBundle` requires it.

    **Commands (M7.1).** `trust.ts` gains three commands, all under the one sequence counter (#26). Schema: `contracts/command.schema.json`.
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
    - **Pairing** (`pairing.ts`): a wizard, Admin only: keys → connect (host key shown, nothing pinned) → pin-host (the Admin compares; only the key the app saw can be pinned) → prepare → confirm. `prepare` builds the genesis `trust-keys` command (app origin, rpId, target, app signing key, every approved, non-removed Admin passkey, the app's current rule, `from` = the target's last command and release numbers, #34) and one fingerprint (#31, the same `genesisFingerprint` production computes). `confirm` takes the confirming Admin's passkey assertion over the command's challenge and checks it with `acceptCommand` on an empty state, exactly as production will, before anything is written to the inbox. The person at the server then confirms the fingerprint (#25). A heartbeat saying `paired` only changes the status shown; it approves no key (see the second security review below). Confirm checks the keys and the rule again (409 `needs-re-preparing`).
    - **Numbers belong to the target** (`deploy_targets.last_sequence/last_release`), not to a host, so re-pairing keeps them. `allocateSequence` is the one command counter (#26). The heartbeat's numbers are never imported (it is untrusted).
    - **Host keys:** pinned in `deploy_targets.host_fp`, never as a side effect of connecting. A changed key gives `host-key-changed`; re-pairing is a new `connect`.
    - **Certificates** (`certs.ts`): `Issuer` with `TestIssuer` (local CA) and `AcmeIssuer` (acme-client, DNS-01 through an injected `DnsProvider`; tested with a mock client only). A CSR is accepted only if its names are all in the target's list (`deploy_targets.domains`, entered by the Admin; never from the heartbeat). The app checks the Issuer's answer is for the CSR's key before sending, signs a `cert` command with its own key (no passkey) and writes it to the inbox. Renewal from the stored CSR when two thirds of the validity have passed (day 60 of 90); a failed renewal is retried after an hour; an Admin warning (notification and mail, once) when 14 days or less are left.
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
      - **When it counts:** a raise counts in the app at once (stricter is safe). A lowering counts when the signed change is delivered, since its signatures already meet the current rule; production's result only moves the status shown.
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

49. **M8 defaults (M8.1–M8.4), accepted with the overnight plan of 22 Oct:**
    - **Endpoints** are in `model_endpoints` (keys sealed with the mail module's AES-256-GCM box, never returned; `keySet` only). **Roles:** writer, sorter, critic, analyst, design, suggestions, in `model_roles`.
    - **Lookup:** `endpointFor(ctx, role, fallback)`: the mapped endpoint; else the first endpoint an Admin added; else the `.env` endpoint. Callers: brief and structure use sorter, design uses design, checkmark suggestions use suggestions, the failure analyst uses analyst. The critic and writer roles have no caller yet. `usage.model_role` values written by callers (planner, designer) are unchanged.
    - **Test connection** tries json_schema, then json_object, then none (a 400/422 or a non-matching reply moves down; 401, 5xx or no connection stops). An explicit capability is an Admin override and survives later tests.
    - **Usage:** `usage_daily` holds per-project daily totals. The retention job (setting `usage_retention_days`, default 90, run hourly from main.ts and by an Admin button) folds per-person rows (rows with a user) into it, then deletes them. Per-person figures: `/api/usage/person/:handle`, 403 for anyone but that person and Admins.
    - **Backups:** target folder must be absolute and outside DATA_DIR; restore goes to a new absolute folder outside DATA_DIR. The timer runs hourly and needs `BACKUP_PASSPHRASE` in the environment; without it scheduled backups do not run. A failed run adds a `backup-failed` inbox item.
    - **Project settings** (`settings` key `project.<id>.settings`): members, structureNeedsAdmin, two-person rule and check levels, stricter than the install only.
    - **Review fixes, 22 Oct (M8):**
      - **SVG stripping is one indexOf scan per pass** (at most 20 passes, each linear). A `<!--` without `-->`, or a `<metadata>` (any prefix, any case) without its end tag or without `>`, is refused at once. A name whose local part starts with `metadata` and a non-word character (`metadata-x`) is refused, as before.
      - **JPEG stripping walks the entropy-coded data.** FF00 and RSTn are data; any other marker starts a segment with the same drop rule (APP1, APP13, COM, and APP2 when it is `MPF\0`; ICC_PROFILE stays). The output ends at the first EOI; everything after it is dropped (MPF secondary images, appended previews). A file no longer has to end in FFD9 to be accepted, only to reach an EOI.
      - **Reserved project IDs.** `DATA_DIR_ENTRIES` in `server/store/revisions.ts` is the one list of top-level names in DATA_DIR: keys, media, brand, checks, studio.sqlite (-wal, -shm), blobs, packages, backups, deploy, release-log, releaselog, releases. `RESERVED_PROJECT_IDS` (each name's slug, the database by its base name `studio`) is refused at creation as `slug-taken` with `reserved: true` and a suggestion (`keys2`). Backup's `TOP_LEVEL_EXCLUDED` is the entries marked `backup: false` (checks and the database files), so keys, media and brand still travel with a whole-instance backup. A project-scope backup of a reserved ID is refused.
      - **Model endpoints.** Changing the base URL's origin clears the sealed key unless a new key comes in the same request. Test connection refuses loopback (127/8, ::1, localhost, *.localhost), 0.0.0.0/8, link-local (169.254/16, fe80::/10), 169.254.169.254, fd00:ec2::254, 100.100.100.200, IPv4-mapped/compatible and NAT64 forms of those, and metadata names (metadata, metadata.google.internal, metadata.goog, instance-data[.ec2.internal]); for other names it checks what DNS gives now. The `.env` endpoint's origin is allowed. Tests pass `createApp({ testOnly: { localModelHosts: true } })`. Test connection calls with `redirect: 'error'` (a new optional `LlmInput.redirect`; other calls still follow redirects). The result carries `status` and `refused`; `error` is written from the status, never the reply's bytes, and that is also what is stored.

35. **Rollback is `activate`** (updates #6). One Admin signs an `activate` command (24-hour lifetime) that switches back to an earlier release still kept on the server. Release numbers keep moving forward. Going back further than the releases kept on disk means repackaging the old site as a normal release, under the full rule. `release.json` no longer has `contentOf`.
