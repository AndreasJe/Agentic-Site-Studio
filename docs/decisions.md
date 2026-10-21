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

35. **Rollback is `activate`** (updates #6). One Admin signs an `activate` command (24-hour lifetime) that switches back to an earlier release still kept on the server. Release numbers keep moving forward. Going back further than the releases kept on disk means repackaging the old site as a normal release, under the full rule. `release.json` no longer has `contentOf`.
