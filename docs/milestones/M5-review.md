# M5 · Review mode

**Plan:** §6.2, §7, §13.2a. **Screens:** `Review.dc.html`. **Decisions:** #8.

## Build
Review shell on the preview origin, the seven checkmarks per section (Copy, Media, Interactions, Mobile, Motion, Translated, Tested), derived status, locking and deliberate unlocking, accepting accessibility findings with a reason, "Approve revision", and the context line (page · revision · Lead · sections approved · package hash).

## Done when
- [x] Only a person can switch a checkmark on; AI suggestions are shown but never applied.
  *Test:* `apps/studio/test/review.test.ts` › AI suggestions are returned for a section and never change a checkmark or any stored row; `apps/studio/test/shell.e2e.ts` › review: Suggest checkmarks shows "Looks ready" and ticks nothing; › review: spoofed messages from the shell frame change nothing
- [x] Interactions can't be ticked with open interaction questions; Mobile can't be ticked without a mobile version.
  *Test:* `apps/studio/test/design.test.ts` › Interactions needs zero open questions; Mobile needs a mobile variant (the Review screen uses the same endpoints)
- [x] Approve revision stays disabled until every section of every Lead is approved.
  *Test:* `apps/studio/test/review.test.ts` › approving a revision (blockers; the rule reads the revision, not the live database); `apps/studio/test/shell.e2e.ts` › review: the shell loads … Approve revision is disabled; › review: approve every section, save a revision, approve it and see the hash
- [x] Spike 3's attacks still fail against the real review shell.
  *Test:* `apps/studio/test/review-isolation.e2e.ts` › every spike 3 attack fails when the bad package runs as the top page (CSP violations as positive evidence; the LAN decoy gets nothing); › inside the real review shell the package runs no script; `apps/studio/test/preview-review.test.ts` (signed links, path confinement, the app CSP, `bad-origin` for preview and `null` origins)

**Result (21 Oct):**
- **How it was built:** Sonnet agents built the server (step 1) and the Review screen (step 3). The shell serving, the app CSP and the attack run (step 2) were built on the strongest model.
- **Decisions:** the defaults are decision #46.
- **Security review:** one round (Opus, high). Findings and what happened:
  - Package paths with digits: fixed.
  - The ambiguous hash framing: fixed.
  - Approval going backwards: fixed.
  - Acceptance rule ids: limited to axe ids.
  - Dotted page paths: fixed.
  - Package `frame-ancestors 'self'` only: tried and reverted, because the check covers every ancestor and broke review.

Deferred:
- Share preview;
- the CSP-off attack run;
- the TLS run on the test VM;
- a browser test for accepting a finding (the mock gives no axe finding);
- page titles in the page picker.

Also open: the Danish strings are first drafts.
