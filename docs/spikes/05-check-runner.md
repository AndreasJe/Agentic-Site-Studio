# Spike 5 · The check runner worker

**Time box:** one day. **Plan:** §8.1, §13.5, §16.5; decisions #2, #11–#17.

## Do
1. A separate Node + Playwright worker that takes jobs from a queue (concurrency 1–2).
2. Runs on one approved package: HTML validation, links, CSP-violation check (console), axe, sitespeed.io with Lighthouse, the 3D and heavy-animation profile, screenshots at three breakpoints with animations frozen.
3. Each check honours Off / Warn / Block from the Checks tab; the security floor is always Block.

## Pass when
- A clean package passes; seeded bad packages fail the right checks (inline script, eval in a library, missing poster, canvas as LCP, broken link).
- Memory and disk stay within 2–4 GB RAM per check and 2–3 GB for browsers.
- Screenshot diffs are stable across two runs of the same package.

## Progress (21 Oct, local)

Built in `spikes/05-check-runner/` (Node, playwright-core with installed Edge, `node --test test/*.e2e.js`): 12 tests pass on Windows, about 4 minutes. File queue (pending, running, results; concurrency 1-2), static package server with the contract CSP (`frame-src 'none'` in place of the video-host placeholder), checks html (html-validate), links, inline-code, csp, axe, heavy-profile, screenshots, and a `performance` stub ("not run (needs sitespeed.io, pending approval)"). Each check has Off / Warn / Block; the floor (csp, inline-code, plus html and links per plan 16.5) ignores a lower setting and reports "can't be lowered".

| Pass-when line | Status |
|---|---|
| A clean package passes | passed locally |
| Seeded bad packages fail the right checks: inline script (csp + inline-code, both floor), eval in a library (csp), missing poster (heavy-profile), canvas as LCP (heavy-profile), broken link (links); nothing else fails | passed locally |
| Floor checks can't be lowered; non-floor Off/Warn honoured | passed locally |
| Concurrency 2 runs two jobs at once, 1 does not | passed locally |
| Screenshot diffs stable across two runs (3 breakpoints, 2 pages, same machine and Edge) | passed locally: diff ratio 0 on all 6 shots, clean and canvas-lcp (canvas masked). Linux stability pending (VM) |
| Memory within 2-4 GB RAM per check | informational locally: solo clean job peaked at worker about 200 MB RSS and browser about 540 MB (Windows working set, shared pages counted). With two jobs at once the browser figure reads up to about 1.2 GB because the sampler counts every new msedge process. Real sizing pending (VM) |
| Disk 2-3 GB for browsers | pending (VM) |
| sitespeed.io with Lighthouse, page-type budgets | pending (sitespeed.io approval) |

Notes:
- Chrome never reports `<canvas>` as an LCP candidate, so "canvas as LCP" is implemented as: LCP element is a canvas, or a canvas is at least as large as the reported LCP element.
- Heavy profile covers only video poster, canvas not largest, and reduced-motion support. Model and texture size limits, Draco/KTX2, lazy scene, DPR cap and DOM controls need thresholds from Design setup and are not checked yet.
- axe needs a context with `bypassCSP` (it injects its script; page bytes are untouched). Without it, `AxeBuilder.analyze` hung on the contract CSP.
- A synchronous `tasklist` call for memory sampling starved Playwright and looked like hangs; sampling is async now.
- Screenshots use `reducedMotion: 'reduce'`, an added style tag, videos paused at 0, canvases masked, seeded `Math.random`.
