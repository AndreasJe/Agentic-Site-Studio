# M7 · Release, production agent and Admin

**Plan:** §13.3–§13.11, §16. **Screens:** `AdminInbox.dc.html`, `AdminReview.dc.html`, `AddressRequest.dc.html`, `AdminDeployment.dc.html`, `AdminGovernance.dc.html`, `AdminUsers.dc.html`, `AdminMail.dc.html`, `AdminLanguages.dc.html`. **Decisions:** #1, #3, #6, #9.

## Build
Waiting for you, the review page with per-section visual comparison and warnings to acknowledge, passkey approval (one or two Admins), send back, address requests, the Deployment tab (pairing wizard, inbox/outbox, health, certificates, releases, rollback, kill switch), Governance with presets and the security floor, Users and keys, Notifications and mail, Site settings › Languages, the production agent.

## Done when
- [ ] All permission tests pass, including: a Creator can't publish; production refuses an unsigned or replayed release; freeze works on the app's signature alone and unfreeze needs a passkey; no email link performs an action.
- [ ] A failed smoke test switches production back on its own and the Admins are emailed.
- [ ] Lowering the two-person rule needs the current rule.
