# Questions from the overnight run

## M7 production agent (apps/agent)
- **Freeze and visitors.** Plan §13.6 mentions "the maintenance page shown while frozen"; #33 says freeze stops releases and activate. The agent keeps serving the active release while frozen (safer: freeze needs only the app's key, so a taken-over app could otherwise take every live site down). A maintenance page while frozen needs your call, and probably a passkey.
- **One site per agent.** The agent serves the one site in its install config and refuses a bundle for another (`wrong-site`). Several sites per target (§13.4) and hostnames signed by a passkey (rule 6) are not built. OK to keep it at one site for M7?
- **A failing first release.** With nothing to switch back to, the agent takes the site offline (503, `taken-offline`) rather than serve a release that failed its smoke test. Or should it keep serving it?
- **Shipping the CSP.** The agent reads `contracts/csp.txt` from the repo, like the preview. A standalone install on the production host needs that file shipped with the agent (or the agent's own copy checked against it in a test).
- **Smoke test without a socket.** It runs through the server's own handler in the process (so the agent opens no client connection at all, as asked). That tests the headers and bytes, not the TLS set-up or the listening port; a check from outside (the app cannot reach production) would need another probe.
- **@peculiar/x509 2.2.0 needs `reflect-metadata`** loaded first (tsyringe). It is a dependency of `apps/agent` (already in the store). `bun install` was run once to link the new workspace: no new packages, and `bun.lock` only gained the `apps/agent` entry. The app's certificate code (M7.6) will need the same import.

## M7 deployment side (pairing, certificates, mail, addresses, languages)
- **Passkey on address approval and mail settings.** Plan §10.4 and §13.7 want a passkey for approving an address and for changing mail settings (and a notice to every Admin at the current and previous address). These routes are Admin-only and audited, but have no passkey step-up yet: the step-up flow is the governance side's. Needs wiring once `stepup.ts` is settled.
- **`reflect-metadata` for the app.** `@peculiar/x509` needs it first, and it is only a dependency of `apps/agent`. `server/deploy/x509.ts` imports it by path from `apps/agent/node_modules`. Add `"reflect-metadata": "0.2.2"` to `apps/studio/package.json` and run `bun install` (no new package, as for the agent), then change that one import.
- **Real issuance is pending DNS and the VM.** `AcmeIssuer` is tested with a mock client. Nothing creates one yet: `main.ts` runs with no issuer, so a CSR is recorded as failed ("no issuer") and an Admin is told. Needs: the ACME directory (staging first), the account email, and a DNS provider for DNS-01 [to be chosen].
- **Admin email addresses.** The app had no email per person. `users.email` is new; an Admin sets it in `/api/mail/addresses`. Until set, an Admin gets the in-app notification only.
- **Address requests become visible when saved.** A request lives in the Creator's private draft until a revision is saved, so the Admin sees it only then. If "send early to reserve the name" must work before saving, the Creator's screen needs its own "Send request" that writes outside the draft.
- **Domains per target.** The names a certificate may carry come from the heartbeat's `site` or the Admin at connect time (`domains`). A wildcard is only possible if the Admin lists it. Several sites per target are not built (agent: one site).
- **Mail for release accepted/refused and new Admin key** is rendered and tested here, but the release and governance sides must call `mailAdmins` (`server/mail/send.ts`) at those moments.
- **Microsoft 365 OAuth** (plan §13.7) is not built; SMTP with a password only.

## M7 release side (release flow, commands, governance, keys)
- **Freeze has no passkey step-up in the app.** Decision #1 says freeze needs only the app's signature, but §13.8 lists freezing among the actions that ask for the passkey again. For now the kill switch is Admin only and audited, with no step-up, so it works at once. Add a step-up if §13.8 should apply literally.
- **The app can't clear the inbox.** The agent expects the app to clear handled files, but `Transport` has no delete, so release bundles stay in the inbox. This needs a `removeInbox(name)` on the transport, and an SFTP chroot that allows it.
- **Only one target.** Releases go to `production`. Governance and key commands go to the one paired target, and they are refused (`several-targets`) when there is more than one, because each target needs its own signatures.
- **Oversize outbox files are read before they are refused.** `readOutbox` can't check the size first. That is fine for SFTP to our own agent; a `stat` on the transport would cap a file before it is read.
- **Most governance settings have no passkey yet.** Plan §16.4 wants a passkey for every Governance change. So far only the two-person rule and the check levels have one. Brief approval and the Creator rights (once they are built) can reuse `stepup.ts`.
- **No mail to the Creator on send back.** Plan §13.3 step 7 wants one, but there is no template yet. The note is stored and shown on the request.
- **No screenshots in the visual comparison.** The M6 worker keeps no screenshots, so the review shows the worker's findings per page and section. Storing the diff images needs a change in the worker.
- **The pairing file's rule comes from the request (security review, for the deployment side).** `preparePairing` takes the rule from the request body; without one, production starts at {1,1,1}. If Admins raised the rule before pairing, one Admin could pair with a lower one. Safer: `pairing.ts` puts `currentPolicy(ctx)` (from `server/governance/policy.ts`) in the genesis file and refuses any other rule. I did not change `pairing.ts` because it is not mine.
- **An "accepted" result in the outbox lowers the app's rule.** Production's outbox is unsigned, so whoever can write to it could report a lowering as accepted, and the app would then ask for fewer signatures. Production still enforces its own copy, so it fails closed there. The safer option needs the VM: an app SFTP account that can't write the outbox, or the rule reported in a signed heartbeat.

## M8 stripping and backups (library only)
- **The upload routes don't strip yet.** `prepareUpload(raw)` in `server/media/media.ts` does `checkFile` then strips and returns `{ mime, bytes }`; a malformed file throws `MediaError('bad-file', 422)`. `server/app/media.ts` (a route file, off limits this run) still calls `checkFile` and stores the raw bytes. Swap its `readFile` to use `prepareUpload`. The existing media tests upload truncated fake JPEG/PNG/WebP files; they will need real minimal files then.
- **Stripping is pure TypeScript.** exiftool (PDF, second opinion for images) and ffmpeg (video) are pending; `stripVideo` throws `needs-ffmpeg` and video upload stays off. Types without a stripper are refused.
- **Backups: rclone is a stub** (`RcloneTarget` throws `needs-rclone`). The remote name and config path are [not decided].
- **Project-scope backups carry the project's rows as JSON** (`.backup/project-rows.json`), not a SQLite file, so other projects' rows never travel with them. Importing those rows into a live database is not built. Whole-instance backups carry a `VACUUM INTO` snapshot as `studio.sqlite`.
- **Backups are built in memory** (one archive, one buffer). Fine for the concept; a streaming format is needed for very large instances.
- **Backup settings** live in `settings` keys `backup_interval_hours`, `backup_last_run`, `backup_keep_last`, `backup_keep_days`; the passphrase is never stored, the caller supplies it. Nothing calls `runIfDue` yet (no timer, no route).
- **Fixed in `store/atomic.ts`:** `syncDir` leaked a directory handle when `fsync` threw (always on Windows), which blocked renaming a folder that held freshly written files. It now closes the handle.

## M8 server (models, usage, backups, setup)
- **Scheduled backups need a passphrase outside the app.** I read `BACKUP_PASSPHRASE` from the environment in main.ts; the plan says the key is kept outside the app but not how it reaches the timer. Without it only "Run now" works.
- **Project settings are stored but not enforced.** `structureNeedsAdmin`, the per-project two-person rule and per-project check levels are not read by the release, structure or check code (some of it was off limits this run). Raising them also has no passkey step-up (§16.4).
- **Archiving a project and per-project backups** (§16.6) are not built: no archive state exists in the database. The Creator rights per project wait for the rights model.
- **Client: the new inbox kind `backup-failed`** needs a title mapping on the Admin inbox screen. New pages the checklist links to: `/admin/models`, `/admin/backups`.
- **Project-scope backups are not in `usage_daily` or model tables;** instance backups carry them in the SQLite snapshot.
- **Lint and tests not green from my side:** `tsc` errors in server/deploy/certs.ts and pairing.ts, test/media.test.ts, and failing certificate, pairing and governance tests come from files the other agents were changing.

- **M7 Admin screens: what has no server API yet.** Users, invitations and role changes (AdminUsers prototype), per-notification recipients (AdminMail), Creator-rights toggles and workflow settings (AdminGovernance), a releases list with revision, approver and signers per release (Deployment shows only the numbers production reports in its heartbeat), server settings and agent updates, and review screenshots with before/after sliders (the worker keeps findings only). The screens show what the APIs give and leave the rest out. Decide where each should live.
- **Pairing wizard offers SFTP only.** The development folder target has no UI; the browser test pairs through its control server.

## M7 security review fixes (findings 1 to 8)
- **Client: re-pairing shows as a candidate.** After connect on a paired target, `target.status` stays `paired` (the live pairing) and the wizard's state is in `target.candidate` (`status`, `host`, `port`, fingerprints, `domains`). AdminDeployment reads `t.status` for the wizard step; it should read `t.candidate?.status` when a candidate exists. Prepare also returns `policy` (the rule the file carries).
- **Certificate names: Admin-entered only.** I required `domains` at connect instead of deriving them from `address_decisions` (those store sub-labels and no project is linked to a target). Decide whether approved addresses should be added to a target's list automatically.
- **A lowering refused by production is not undone in the app.** The lowered rule counts on delivery (finding 6); if production refuses it, the app asks for fewer signatures than production needs until someone raises it again. Production still enforces its own rule. Decide whether a refusal should restore the old rule.
- **New migration `deploy_candidates`** is appended after the M8 migration in server/db/index.ts.

## Review fixes, 22 Oct (findings 1 to 6)
- **The release log's folder name is not decided.** I reserved `release-log`, `releaselog` and `releases` as project IDs. Rename the entry in `DATA_DIR_ENTRIES` when the release log is built.
- **Projects that already have a reserved ID** (made before this fix) are not renamed or moved. None are expected yet.
- **Test connection and DNS rebinding.** The host check resolves the name, but `fetch` resolves it again, so a name that changes its answer in between can still reach a blocked address. A full fix pins the resolved address for the call (needs a custom dispatcher, not built).
- **Only Test connection is host-checked.** Ordinary `llm()` calls to a saved endpoint still go where its base URL points and follow redirects. Their replies only reach code after schema validation. Decide whether saving an endpoint should apply the same rule.
- **Old test errors.** `last_test_error` rows written before this fix may hold up to 300 bytes of a server's reply; they are not cleared. They go on the next test.
- **Client (other agent):** `POST /api/projects` now answers `slug-taken` with `reserved: true` for an app folder name, so the message can say "That name is used by the app" instead of "taken". The Test connection result has new fields `status` and `refused` (`blocked-host`), and its `error` texts changed. An endpoint's `keySet` turns false after its origin changes. Pairing confirm can answer 409 `needs-re-preparing`; the wizard should offer "Prepare again".

