# Spike 3 · Preview isolation and the review shell

**Time box:** half a day. **Plan:** §13.2a, §13.11, §21.1; decisions #4, #7, #8.

## Question
Can generated code run on `preview.internal` without reaching the app on `studio.internal`, while the review shell still reports section clicks?

## Do
1. Serve the app and previews on two hostnames that are different sites (not sibling subdomains, not ports).
2. Serve a package that tries to: read app cookies, POST to the app, open the app in a frame, call WebAuthn for the app's rpId, fetch another LAN host.
3. Build the review shell at `preview.internal/__review/`: same-origin iframe, overlays from `data-section`, postMessage clicks to the app.
4. The app validates message origin and format and never trusts the shell for the section list or package hash.

## Pass when
- Every attack in step 2 fails.
- Section clicks arrive in the app, and a spoofed message can't change what is approved.
