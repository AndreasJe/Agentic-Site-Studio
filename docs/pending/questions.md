# Questions from the overnight run

## M7 production agent (apps/agent)
- **Freeze and visitors.** Plan §13.6 mentions "the maintenance page shown while frozen"; #33 says freeze stops releases and activate. The agent keeps serving the active release while frozen (safer: freeze needs only the app's key, so a taken-over app could otherwise take every live site down). A maintenance page while frozen needs your call, and probably a passkey.
- **One site per agent.** The agent serves the one site in its install config and refuses a bundle for another (`wrong-site`). Several sites per target (§13.4) and hostnames signed by a passkey (rule 6) are not built. OK to keep it at one site for M7?
- **A failing first release.** With nothing to switch back to, the agent takes the site offline (503, `taken-offline`) rather than serve a release that failed its smoke test. Or should it keep serving it?
- **Shipping the CSP.** The agent reads `contracts/csp.txt` from the repo, like the preview. A standalone install on the production host needs that file shipped with the agent (or the agent's own copy checked against it in a test).
- **Smoke test without a socket.** It runs through the server's own handler in the process (so the agent opens no client connection at all, as asked). That tests the headers and bytes, not the TLS set-up or the listening port; a check from outside (the app cannot reach production) would need another probe.
- **@peculiar/x509 2.2.0 needs `reflect-metadata`** loaded first (tsyringe). It is a dependency of `apps/agent` (already in the store). `bun install` was run once to link the new workspace: no new packages, and `bun.lock` only gained the `apps/agent` entry. The app's certificate code (M7.6) will need the same import.
