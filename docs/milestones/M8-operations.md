# M8 · Backups, models, usage and setup

**Plan:** §12, §15, §21.5, §22. **Screens:** `AdminBackups.dc.html`, `AdminModels.dc.html`, `AdminUsage.dc.html`, `AdminSetup.dc.html`, `ProjectSettings.dc.html`, `AdminProjects.dc.html`. **Decisions:** #19, #20, #22.

## Build
Backups through rclone (targets, schedule, scope, retention, encryption, restore as a new copy, SQLite backup command), model endpoints and roles (including the analyst), usage statistics (per site and project by default; per person only for that person and Admins; retention), the setup checklist, Projects overview and Project settings.

## Done when
- [ ] A restore into a clean environment produces an identical project.
- [ ] Per-person usage is aggregated and deleted after the configured period.
- [ ] Metadata is stripped on upload (exiftool for images and PDFs, ffmpeg for video).

**Not in this build:** Generate an image (`design/prototype/MediaGenerate.dc.html`), next round.
