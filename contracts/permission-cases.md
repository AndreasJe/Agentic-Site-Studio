# Permission and security-floor test cases

Each line is an automated test. They run on every change to the app (plan §13.5, "the app's own pipeline"). The milestone that first makes a case testable is in brackets.

## Roles
- A Creator can't publish to production, use the Deployment tab, manage backups, mail, users or models, or use the kill switch. [M1, M7]
- A Creator without the "approve for staging" right can't approve a revision for staging. [M5]
- A Creator can't switch on Think new when Governance restricts it to Admins. [M4]
- Every Governance change needs an Admin passkey and lands in the audit log; lowering the two-person rule needs the current rule. [M7]

## The AI
- No model call has access to tools that touch git, releases, files or settings. [M1]
- Model output that fails its schema is retried at most twice, then fails clearly. [M1]
- A brief field without a source is rejected and becomes "Not set yet." [M2]
- Pasted text, documents, imported briefs and check-runner logs are sent as quoted data; a prompt-injection fixture changes nothing. [M2, M6]
- The analyst can't recommend letting a security-floor failure through, and stops after two fix attempts. [M6]

## Content and history
- A saved revision or blob is never modified; a write that would change one fails. [M1]
- A draft is visible only to its owner. [M1]
- Approved sections are locked; unlocking switches the affected checkmarks off. [M4, M5]
- Only a person can switch a checkmark on. [M5]

## Generated code
- The validator rejects inline scripts, inline event handlers, `eval`, resources from outside the site, forms posting to unknown addresses, fonts and colours outside the guide, and duplicate `data-section` IDs. [M4]
- A page with CSP violations in the console fails the check runner. [M6]
- Generated code on `preview.internal` can't read app cookies, send authenticated requests to the app, frame the app, call WebAuthn for the app's rpId, or reach other LAN hosts. [M5]
- Review approval uses the app's own section list and package hash, never the shell's. [M5]

## Packages and production
- Preview, staging and the release candidate have the same package hash. [M6]
- The security-floor checks always block and can't be lowered, per install or per project. [M6]
- Production refuses a release without a valid Admin signature, with a changed hash, a wrong origin, a missing UV flag, or a release number not higher than any accepted before. [M7]
- With the two-person rule on, production needs signatures from two different Admins. [M7]
- Production refuses a replayed or expired command; freeze is accepted with the app's signature; unfreeze, activate and trust-keys need an Admin passkey. [M7]
- A failed smoke test switches production back to the previous release without a new signature and reports it in the outbox. [M7]
- The production private key never appears in the release log, backups or a secret scan. [M7]
- No email link performs an action; links carry no secrets; mail settings changes need a passkey and notify every Admin. [M7]
- The audit log is always on and the app can't delete from it. [M7]
