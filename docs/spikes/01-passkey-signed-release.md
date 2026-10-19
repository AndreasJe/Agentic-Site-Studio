# Spike 1 · Passkey-signed releases

**Time box:** half a day to a day. **Plan:** §13.3, §13.8, §22.6; decisions #6.

## Question
Can an Admin's passkey (WebAuthn) sign a release, and can production verify that signature on its own, offline, against `APP_URL` and its trusted keys?

## Do
1. In the app, make the WebAuthn challenge `sha256(release package) || release number` (encode as base64url).
2. Have an Admin sign with a platform passkey and with a synced passkey (1Password or similar).
3. On a separate "production" process with no network to the app, verify: the signature over `authenticatorData || sha256(clientDataJSON)`, `clientDataJSON.challenge`, `clientDataJSON.origin == APP_URL`, `rpIdHash == sha256(rpId)`, the user-verification flag, and that the release number is higher than any accepted before.
4. Ignore the signature counter when it is 0.
5. Key chain: a new Admin key is accepted only when signed by an existing Admin (two with the two-person rule).

## Pass when
- A valid release is accepted; a changed byte, a lower release number, a wrong origin or a missing UV flag is refused.
- Works with both a device-bound and a synced passkey.
- The two-person rule can require two signatures from different Admins.

## Progress (19 Oct, not yet a result)

**Done and tested (69 unit tests, 4 browser tests):**
- Do 3 without the release layer: `packages/shared/src/webauthn` verifies registrations and assertions offline with Web Crypto only. It checks the signature, challenge, origin, rpId hash, UP, UV, type and cross-origin, and refuses on any parse error without throwing.
- Do 4: the counter is ignored only when it is 0 on both sides. A 0 after a nonzero count is refused, per WebAuthn §7.2 step 22. This is slightly stricter than "ignore a counter of 0", but synced passkeys report 0 from the start, so they still work.
- Hardening from the first security review:
  - RSA keys must be at least 2048 bits, measured in bits, and use exponent 65537.
  - Small-order Ed25519 keys are refused. Without this check, Bun's Web Crypto accepted a universal forged signature for the identity-point key.
  - "Backed up" without "backup eligible" is refused, and so is credential data inside an assertion.
  - An algorithm can be withdrawn for stored credentials.
- The spike page (`spikes/01-passkey`, `bun run start`, http://localhost:3000) registers and signs in. Browser tests in Edge with the virtual authenticator show:
  - sign-in works with UV;
  - the server refuses a passkey without UV;
  - the server refuses requests from another site;
  - the browser refuses the app's rpId when called from another site.

**Waiting:**
- Do 1, Do 5 and the release-level pass criteria wait for open questions A1 (challenge bytes), A2 (sign-in vs signing challenges), A3 (the first trusted keys) and A4 (command signatures).
- Do 2 needs two real ceremonies by a person: Windows Hello and a synced passkey from 1Password or Bitwarden. Record them on the spike page with a fixture label; `test/fixtures.test.ts` then replays them. They are passkeys for rpId `localhost`, so they can't sign anything for the real app.

**For M1, from the security review** (the spike server is throwaway; the app must do these):
- Bind passkey registration to an authenticated session or setup code.
- Refuse a credential ID that is already registered (the spike does), and for the key chain also a duplicate public key.
- Update the counter atomically (`UPDATE … WHERE sign_count < ?`).
- Check a CSRF token as well as Origin.
- Count two-person signatures by distinct verified public keys, never by ID strings or signature bytes (ES256 signatures are malleable).
