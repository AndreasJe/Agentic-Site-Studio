# Morning summary: overnight run, 22 Oct

## What's done (all committed locally, nothing pushed)
- **M6 speed check:** Lighthouse runs against the installed Edge. Budgets are the Core Web Vitals "good" limits, because §8.1 gives no numbers. sitespeed.io is not used.
- **M7 · Release and production.** Every Done-when item is ticked and backed by a test.
  - The production agent `apps/agent` reads only its inbox and writes only its outbox.
  - It accepts a release or command only when it is signed. It verifies the bundle strictly and switches the live site atomically. A failed smoke test switches back with no signature, and certificates are handled through the folders.
  - The release flow: an Admin review page, passkey signing by one or two Admins, delivery to the inbox, and the outbox read back.
  - Signed commands cover freeze, unfreeze, rollback (activate) and key changes.
  - Governance and keys: presets, a lowered rule needs the current rule, and keys can be added and removed.
  - Deployment: pairing with one fingerprint, certificates through an Issuer, mail whose links only open pages, address approval and languages.
  - The Admin screens are built.
- **M8 · Operations.** Two Done-when items are ticked and the third is ticked in part.
  - Encrypted backup, and restore into a new copy that comes out identical.
  - Model endpoints and roles, with Test connection.
  - Usage per site and project; per-person rows are aggregated and deleted after the retention period.
  - Metadata stripping on upload for JPEG, PNG, WebP, GIF and SVG, in pure TypeScript instead of exiftool. Video waits for ffmpeg.
  - The setup checklist, the projects overview, project settings and the screens.
- **M2:** three Done-when items are ticked against existing tests.
- **Security reviews:** three rounds on Opus at high effort (M7, the M7 fixes, M8). Every high and medium finding is fixed with a test.
- **Suites, last run:**
  - lint is clean;
  - every studio test file passes on its own;
  - packages 197, spikes 45, agent 37, worker 33;
  - browser 37.

## Needs you
1. ~~**Approve the guarded moves.**~~ Done on 22 Oct: the two schemas are in `contracts/`, and decisions #48 and #49 are in `docs/decisions.md`, with three stale lines tidied first.
2. **Answer the questions.** `docs/pending/questions.md` has about 48 items, grouped by area. The ones that matter most:
   - what production serves while frozen;
   - one site per agent;
   - whether the first failing release takes the site offline;
   - shipping `csp.txt` with the agent;
   - freeze has no passkey step-up (#1 vs §13.8);
   - project settings are stored but not enforced;
   - DNS rebinding for Test connection.
3. **Bun 1.4.3 segfaults** in multi-file runs that include the SFTP tests: about 1 run in 3 crashes Bun itself, not a test. Each file passes alone. Options: wait for a Bun fix, or run the SFTP tests under Node.
4. **Delete `backup/before-trailer-removal`** once you're happy with the cleaned history.

## Still pending, by blocker
- **Test VM:**
  - spike 2 for real (sshd chroot, "no outbound route");
  - the agent and worker on their own hosts;
  - worker sizing and Linux screenshots;
  - gitleaks.
- **DNS and a CA:** real ACME DNS-01 issuance. `AcmeIssuer` is unit-tested only, and no issuer is configured in `main.ts`.
- **Tools:** rclone for backup targets (a stub says so), ffmpeg for video.
- **Bjarke's files:** M2 Markdown import and export.
- **A real model endpoint:** everything AI is tested against the mock.
- **Not built** (no server API, or deferred): users, invitations and roles; per-notification recipients; screenshot sliders in review; archiving a project; the critic; the AI code review.

## Where to look
- `git log --oneline` shows the overnight commits.
- The milestone Results are at the bottom of `docs/milestones/M7-*.md` and `M8-*.md`.
- The dev server is at http://localhost:3000; the Admin screens need an Admin passkey.
