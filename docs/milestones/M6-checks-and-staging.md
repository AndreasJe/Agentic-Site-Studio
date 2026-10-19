# M6 · Packaging, check runner and staging

**Plan:** §8, §9, §13.2, §13.5, §16.5. **Screens:** `Staging.dc.html`, `AdminChecks.dc.html`, `AdminFailure.dc.html`. **Decisions:** #2, #5, #8, #11–#17, #21.

## Build
Build once into one package with one SHA-256 (minify, hash file names, sitemap.xml, robots.txt), the check-runner worker from spike 5 with Off / Warn / Block, staging on the preview address, "Request publication" with a plain-text note, the Checks tab, and self-healing failure analysis (analyst model role, fixed output schema, redacted input, cost cap, two attempts).

## Done when
- [ ] Preview, staging and the release candidate have the same hash.
- [ ] Every security-floor check blocks and can't be lowered.
- [ ] The analyst never recommends letting a security-floor failure through and has no tools; its fix becomes a new revision that goes through review mode.
- [ ] A newer publication request closes the older one.
