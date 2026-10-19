# M1 · Walking skeleton

**Plan:** §11, §12.1, §14, §15. **Decisions:** #10, #18.

## Build
- Repo layout, Bun + Hono API, Svelte SPA served by the same process, SQLite, `DATA_DIR`.
- Accounts and roles (Admin, Creator), test accounts for the concept, sessions with Origin + CSRF checks.
- Projects with locked slug IDs (`QualiWare GO` → `qualiwarego`, collision → `qualiwarego2`).
- Drafts (private, autosaved), versions, revisions (`<project>-r<n>`, allocated by the home instance), content-addressed blobs, atomic writes, `project.json` rebuildable from `revisions/`.
- `llm()` with usage logging (every field in §15) and the structured-output rules from spike 6.
- The app shell from `design/`: top bar, prototype-free role-aware navigation, project bar with the workflow spine, decision bar.

## Done when
- [ ] Two users edit the same design at once; each gets their own draft; saving creates `r<n>` and `r<n+1>` with the right parents; nothing is lost.
- [ ] Killing the process mid-write never leaves a half-written revision.
- [ ] `project.json` can be deleted and rebuilt identically.
- [ ] Every `llm()` call writes a usage row, including retries.
- [ ] The permission tests in `contracts/permission-cases.md` that apply to M1 pass.
