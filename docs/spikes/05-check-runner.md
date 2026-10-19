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
