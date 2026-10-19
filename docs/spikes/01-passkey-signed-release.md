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
