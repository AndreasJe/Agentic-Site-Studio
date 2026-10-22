# Changelog

## 0.1.0-rc.1 (22 Oct 2026)

This is the first release candidate. The whole workflow, from brief to production, is built and tested locally. Every AI feature runs against the mock model.

### What's in it

- **Foundation (M1):** write-once revisions and a content-addressed blob store, SQLite, Creator sign-in, Admin passkeys, Origin and CSRF checks, private autosaved drafts, and one `llm()` function with usage logging.
- **Brief (M2):** the brief board and its AI ways in. A field without a source becomes "Not set yet."
- **Structure (M3):** pages, menu, paths and redirects, plus AI proposals that you accept or reject.
- **Design (M4):** the brand guide on a shared OKLab colour module, a media library, and AI design takes that a strict validator checks. Previews are served from the separate preview site.
- **Review (M5):** a write-once review package for each revision, a sandboxed review shell, checkmarks, accessibility acceptances with a reason, and approval.
- **Checks and staging (M6):** the site is built once into a single SHA-256 package. The check runner (`apps/worker`) covers HTML, links, CSP violations, inline code, axe and Lighthouse, and the security-floor checks always block. Staging serves the same bytes. A failure analyst has no tools.
- **Release and production (M7):** releases signed with one or two Admin passkeys, SFTP to the inbox, and the production agent (`apps/agent`). The agent verifies strictly, switches atomically and switches back if the smoke test fails. Freeze, unfreeze, rollback and key commands are signed, and governance presets are included.
- **Operations (M8):** encrypted backup and restore, model endpoints, usage, metadata stripping on upload, the setup checklist, and project settings.
- English and Danish in the UI.

### Known limitations

- **No real model endpoint yet.** Every AI feature is tested against the mock.
- **Not yet on real hosts.** Spike 2 (sshd chroot, no outbound route), the separate agent and worker hosts, and real ACME issuance all wait for the TAPPaaS VMs (`docs/vm-setup.md`).
- **Not built yet:**
  - user management, invitations and roles;
  - per-notification recipients;
  - screenshot sliders in review;
  - archiving a project;
  - the critic and the AI code review;
  - Markdown import and export for the brief;
  - backup targets through rclone;
  - video metadata stripping (it needs ffmpeg).
- **Bun 1.4.3 sometimes crashes** in multi-file test runs that include the SFTP tests. Each file passes on its own.
