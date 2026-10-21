# M6 · Packaging, check runner and staging

**Plan:** §8, §9, §13.2, §13.5, §16.5. **Screens:** `Staging.dc.html`, `AdminChecks.dc.html`, `AdminFailure.dc.html`. **Decisions:** #2, #5, #8, #11–#17, #21.

## Build
Build once into one package with one SHA-256 (minify, hash file names, sitemap.xml, robots.txt), the check-runner worker from spike 5 with Off / Warn / Block, staging on the preview address, "Request publication" with a plain-text note, the Checks tab, and self-healing failure analysis (analyst model role, fixed output schema, redacted input, cost cap, two attempts).

## Done when
- [x] Preview, staging and the release candidate have the same hash.
  *Test:* `apps/studio/test/build.test.ts` › the same revision gives a byte-identical archive and hash in fresh dirs; `apps/studio/test/review.test.ts` (the approval records the archive hash); `apps/studio/test/checks.test.ts` › a clean result finishes the run, stages the revision…; `apps/studio/test/preview-review.test.ts` › staging links serve the same package bytes. *Not covered here:* the release candidate itself is M7's bundle, which must name this hash (decision #47).
- [x] Every security-floor check blocks and can't be lowered.
  *Test:* `apps/studio/test/checks.test.ts` › a floor setting cannot be lowered; `apps/worker/test/jobs.node.js` (a floor setting of off is ignored, the seeded bad packages, hash mismatch, tar refusal), run with `bun run test:worker`.
- [x] The analyst never recommends letting a security-floor failure through and has no tools; its fix becomes a new revision that goes through review mode.
  *Test:* `apps/studio/test/analyst.test.ts` › let-through on a floor failure becomes hold; › the cost cap is in the call, and the model is given no tools; › send-fix makes a take and no revision; › the third gives 409 person-takes-over; › redaction covers every format the worker secrets check flags.
- [x] A newer publication request closes the older one.
  *Test:* `apps/studio/test/checks.test.ts` › a newer request supersedes the older, in one step; `apps/studio/test/shell.e2e.ts` › staging: … a second request supersedes the first.

**Result (22 Oct):**
- **How it was built:** Sonnet agents built steps 1–5. The staging serving was built on the strongest model.
- **Decisions:** the defaults are decision #47. The shared job and package format is in `docs/m6-interfaces.md`.
- **Security review:** one round (Opus, high), with every finding fixed and tests added:
  - the staging frame is now sandboxed;
  - redaction is aligned with the worker's secret rules, and flagged files are left out of the analyst's input;
  - guide breaks no longer block the floor, and a missing guide falls back to the seed;
  - the two-analysis cap is reserved before the model call;
  - floorFailed fails closed;
  - an oversize file is a secrets finding;
  - the baseline is hash-checked;
  - the worker suite has a root script (`bun run test:worker`).

Pending:
- the speed check (sitespeed.io and Lighthouse; needs your approval; a stub reports "not run");
- the AI code review;
- worker sizing, Linux screenshot stability, gitleaks and the worker on its own host (test VM);
- the passkey step-up for check settings, the Admin inbox and mail (M7);
- the prototype's check matrix, scheduled jobs and analyst guidelines on AdminChecks.

The worker suite (about 5 minutes) is not in the end-of-turn hook.
