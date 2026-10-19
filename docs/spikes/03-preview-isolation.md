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

## Result

**Pass, locally (19 Oct 2026).** Code in `spikes/03-preview-isolation/`. App on `http://localhost:<port>`, preview on `http://127.0.0.1:<port>`: different hosts, so different sites, with no hosts file or certificates. Browser tests run in the installed Edge (`bun run test:browser`); unit tests cover the Origin/CSRF middleware, the message validator and the two servers' headers (`bun test`).

Run 1 has the contract CSP on the package (`frame-src 'none'` for the video placeholder, `frame-ancestors 'self' <APP_URL>` per #38). Run 2 turns the header off (`PREVIEW_CSP=off`) to see what SameSite, Origin and CSRF do on their own.

| Attack from the package | CSP on | CSP off |
|---|---|---|
| Read `document.cookie` | Fails: empty | Fails: empty (different host) |
| Credentialed `fetch` POST to the app (no-cors, text/plain) | Fails: connect-src violation; app received nothing | Fails: arrives without the cookie, 403 bad-origin |
| `fetch` GET of an app API | Fails: connect-src violation | Fails: no cookie, 401; response unreadable (no CORS) |
| Image beacon to the app | Fails: img-src violation | Fails: no cookie, 401 |
| Form POST to the app | Fails: form-action violation | Fails: arrives with `Origin: null` and no cookie, 403 |
| Frame the app's review page | Fails: frame-src violation, error page | Fails: request arrives (no cookie), app's `frame-ancestors 'none'` gives an error page |
| `navigator.credentials.get` with rpId `localhost` | Fails: SecurityError top-level; NotAllowedError when framed | Same |
| fetch, image, WebSocket to another local port | Fails: connect-src / img-src violations; the decoy host received nothing | **Reaches the host** (fetch, image, socket open) |
| Spoofed `section-click` (known and unknown id) and `approve` posted to the app | Fails: all rejected as wrong-source; selection and approvals unchanged | Same |
| Same messages posted to the shell | Ignored: the shell has no message listener | Same |

A real overlay click in the shell selects the section in the app; from the real shell, an unknown id is rejected (unknown-section) and an extra field is rejected (bad-shape). Approval only changes through the app's button, which POSTs with the CSRF token. The preview never sets a cookie and serves every package file byte for byte.

**What we learned**

- The CSP is the only thing that stops LAN reach. With the header off, the authenticated requests still failed, but the decoy host was reached. The header must be on every preview, staging and production response; a test should check for it.
- frame-ancestors is checked against every ancestor, so `'self' <APP_URL>` is exactly what the app → shell → package nesting needs (#38).
- Inside the framed review, WebAuthn fails with NotAllowedError (Permissions Policy, cross-origin iframe) before the rpId check. Top-level, as a shared preview link would be, it fails with SecurityError.
- With `Referrer-Policy: no-referrer` on the preview, a cross-site form POST carries `Origin: null`. The Origin check has to treat `null` as a mismatch, never as "no Origin, let it through". The unit tests cover this.
- `__Host-` with `Secure` works on `http://localhost` in Edge, so local development can keep the production cookie attributes.
- Every cross-site request carried `Sec-Fetch-Site: cross-site`. It could be a cheap extra check on the app; not needed for this result.
- Not tested, accepted by #8: the package shares an origin with the shell, so it can reach the shell's DOM and fake an overlay click with a known id. That can only change the selection, as the spike shows.

**Against the plan**

- Nothing contradicts §13.2a or #4, #8, #38–#40.
- §13.2a says the app adds a short-lived access token when it loads a preview. Not built here. If it travels in the URL, the package can read it (same origin); it can't send it anywhere under the CSP, but top-level navigation can (the risk #40 accepts). Worth keeping that token single-use or bound to the shell load.

**Still to do:** the same run on the test VM over TLS with `studio.internal` and `preview.internal` (real hostnames, real certificates, `Secure` cookies over HTTPS), including the check that the two names are different sites.

## Must-do when this becomes real code (security review of a073c14)

Not fixed in the spike; required in M1 (app guard and cookies) and M5 (review shell):

1. **The package can become the shell.** It shares the shell's origin, so it can inject a script into the shell or navigate the shell frame, and then send messages that pass the source check. So:
   - pin the app's `frame-src` to `<preview>/__review/` and the shell's `script-src` to its own file;
   - treat every shell message as controlled by the package: it may only change the selection, never approve;
   - add a browser test for both attacks.
2. **No switch may turn off the preview CSP.** It is the only control against LAN reach (#40). The CSP-off test run must strip the header in the test, not in the server.
3. **Make the CSP-off assertions specific.** Assert the refusal reason (`bad-origin`), not only 403. Add a top-level cross-site form POST, which reaches the Origin check under Lax.
4. **Don't let "the app received nothing" pass vacuously.** It must also fail if the app and preview turn out to be the same site; assert on `origin`, not only `sec-fetch-site`. The TLS run on the VM must confirm the two hosts are different sites.
5. **Never pass the app's query string to the shell or package URLs.** Build those URLs from an allow-list. The §13.2a access token must not be readable by the package: make it single-use, or bound to the shell load.
