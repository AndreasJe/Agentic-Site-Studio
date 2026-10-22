# M8 · Backups, models, usage and setup

**Plan:** §12, §15, §21.5, §22. **Screens:** `AdminBackups.dc.html`, `AdminModels.dc.html`, `AdminUsage.dc.html`, `AdminSetup.dc.html`, `ProjectSettings.dc.html`, `AdminProjects.dc.html`. **Decisions:** #19, #20, #22.

## Build
Backups through rclone (targets, schedule, scope, retention, encryption, restore as a new copy, SQLite backup command), model endpoints and roles (including the analyst), usage statistics (per site and project by default; per person only for that person and Admins; retention), the setup checklist, Projects overview and Project settings.

## Done when
- [x] A restore into a clean environment produces an identical project.
  *Test:* `apps/studio/test/backup.test.ts` › restore into a clean dir gives identical files, hashes, project.json and rows; `apps/studio/test/admin-ops.e2e.ts` (backup and restore from the screen).
- [x] Per-person usage is aggregated and deleted after the configured period.
  *Test:* `apps/studio/test/operations.test.ts` › retention aggregates per-person rows into daily project totals, then deletes them; › the retention period is a setting, changed by an Admin only.
- [~] Metadata is stripped on upload (exiftool for images and PDFs, ffmpeg for video). **Images and PDFs: done in pure TypeScript instead of exiftool** (JPEG, PNG, WebP, GIF, SVG; PDF since M2). **Video: pending ffmpeg**; video upload stays off.
  *Test:* `apps/studio/test/strip.test.ts` › GPS, XMP, IPTC and comments are gone; › an appended Exif+GPS JPEG after EOI is cut off…; `apps/studio/test/media.test.ts`.

**Result (22 Oct, overnight run):** decision #49. One security review (Opus, high); every finding is fixed:
- linear SVG stripping;
- JPEG walked to EOI, with MPF dropped;
- reserved project ids;
- the model key cleared on an origin change, and Test connection refuses internal hosts.

Pending:
- rclone targets (a stub reports "needs rclone");
- ffmpeg for video;
- project settings are stored but not yet enforced;
- archiving a project.

**Not in this build:** Generate an image (`design/prototype/MediaGenerate.dc.html`), next round.
