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
