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
- [x] Two users edit the same design at once; each gets their own draft; saving creates `r<n>` and `r<n+1>` with the right parents; nothing is lost.
  *Test:* `apps/studio/test/drafts.test.ts` › "two people edit from r3 at once…"
- [x] Killing the process mid-write never leaves a half-written revision.
  *Test:* `store.test.ts` › "never leaves a half-written revision (100 hard kills)"
- [x] `project.json` can be deleted and rebuilt identically.
  *Test:* `revisions.test.ts` › "project.json can be deleted and rebuilt byte for byte"
- [x] Every `llm()` call writes a usage row, including retries.
  *Test:* `test/llm/llm.test.ts` (one row per attempt, including invalid, HTTP 500 and aborted)
- [x] The permission tests in `contracts/permission-cases.md` that apply to M1 pass:
  - a Creator can't use Admin capabilities: `auth.test.ts` › roles;
  - no model call has tools: `llm.test.ts`;
  - at most two retries, then a clear failure: `llm.test.ts`, including a caller asking for more;
  - saved revisions and blobs never change: `store.test.ts`;
  - a draft is visible only to its owner: `drafts.test.ts`.

**Result (19 Oct):**
- 271 unit tests and 19 browser tests pass.
- One security review was done; all five of its findings are fixed:
  - the app and preview must be different sites;
  - the same passkey key under a new credential ID is refused;
  - sessions are stored by hash;
  - the two-retry cap is enforced;
  - a weak test was strengthened.
- Open for later:
  - the role-guard test should list the app's real Admin routes once they exist (M7);
  - the draft-privacy test covers reads but not another member's save or delete;
  - Danish strings beyond sign-in and the project bar are a first draft and need a Danish speaker;
  - fonts are self-hosted only after your OK; the fallback stacks are used until then.
