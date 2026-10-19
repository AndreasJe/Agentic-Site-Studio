# Spike 4 · Certificates through the outbox

**Time box:** half a day. **Plan:** §13.6, §13.11; decisions #3.

## Do
1. Production generates a private key and writes a CSR for `example.com, *.example.com` (test domain) to its outbox.
2. The app runs ACME with a DNS-01 challenge (staging CA) and drops the signed certificate in the inbox, signed by the app.
3. Production checks the app signature, that the certificate matches its key and domain, installs it and reloads.
4. Simulate renewal at day 60.

## Pass when
- The private key never leaves production (not in the release log, backups or secret scan).
- Renewal needs no passkey.
- Fallback documented: key encrypted to production's public key, sent on the certificate channel.
