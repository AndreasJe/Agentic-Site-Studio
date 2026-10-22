# M7 · Release, production agent and Admin

**Plan:** §13.3–§13.11, §16. **Screens:** `AdminInbox.dc.html`, `AdminReview.dc.html`, `AddressRequest.dc.html`, `AdminDeployment.dc.html`, `AdminGovernance.dc.html`, `AdminUsers.dc.html`, `AdminMail.dc.html`, `AdminLanguages.dc.html`. **Decisions:** #1, #3, #6, #9.

## Build
Waiting for you, the review page with per-section visual comparison and warnings to acknowledge, passkey approval (one or two Admins), send back, address requests, the Deployment tab (pairing wizard, inbox/outbox, health, certificates, releases, rollback, kill switch), Governance with presets and the security floor, Users and keys, Notifications and mail, Site settings › Languages, the production agent.

## Done when
- [x] All permission tests pass, including: a Creator can't publish; production refuses an unsigned or replayed release; freeze works on the app's signature alone and unfreeze needs a passkey; no email link performs an action.
  *Test:* `apps/studio/test/release.test.ts` › a Creator cannot publish, sign, freeze, unfreeze, roll back, or touch governance and keys; › an unsigned or replayed release is refused by production…; › freeze works on the app signature alone…; › unfreeze without a passkey is refused, here and by production…; `apps/agent/test/release.test.ts` › a replayed bundle is refused…; › an unsigned or wrongly signed bundle is refused; `apps/studio/test/mail.test.ts` › every template, in both languages, links to a page of the app and nothing else; `apps/studio/test/release.e2e.ts` (passkey signing in the browser).
- [x] A failed smoke test switches production back on its own and the Admins are emailed.
  *Test:* `apps/agent/test/smoke.test.ts` › a package whose index 404s switches back to the previous release and says so; › missing security headers switch back too; `apps/studio/test/mail.test.ts` › a failed smoke test that switched production back emails every Admin and notifies.
- [x] Lowering the two-person rule needs the current rule.
  *Test:* `apps/studio/test/release.test.ts` › presets; raising needs one Admin, lowering the two-person rule needs the current rule (two); › production refuses a lowering signed by fewer Admins than the current rule.

**Result (22 Oct, overnight run):**
- **Built on local stand-ins** (plan of 22 Oct; decision #48):
  - the production agent (`apps/agent`);
  - the SFTP transport, against a local ssh2 server;
  - certificates, against a local test CA;
  - mail, against a local SMTP sink.
- **Security reviews:** two rounds on Opus, high. Every finding is fixed, with tests:
  - pairing uses the current rule and only approved keys, re-checked at confirm;
  - certificate names are entered by an Admin;
  - outbox reads are size-capped;
  - re-pairing keeps the live pairing;
  - the outbox is display-only;
  - the agent refuses non-regular inbox files;
  - certificate commands go through the stale handling;
  - removed keys are checked at delivery.

Pending:
- **Test VM:** a real sshd chroot, "no outbound route", and the agent on its own host.
- **DNS and the VM:** real ACME issuance.
- **Bun bug:** a Bun 1.4.3 segfault that intermittently kills runs of the SFTP tests.
- **Decisions for you:** the open questions in `docs/pending/questions.md`.
