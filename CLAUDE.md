# Site Studio (working name)

A web app where people without design or technical skills build static websites with AI, from brief to live site. The workflow is the product:

**Brief → Structure → Design → Review → Staging → Publication**

The AI drafts; people decide. Two roles: **Creator** (design and content) and **Admin** (everything, plus production, deployment and governance).

## Where things are

| Path | What |
|---|---|
| `docs/plan.md` | The full plan (v4.0). Source of truth for behaviour, wording and rules. Read the section you need, not the whole file. |
| `docs/decisions.md` | The 22 developer decisions (19 Oct). They override anything older in the plan. |
| `docs/spikes/` | Time-boxed experiments to run before building on them. |
| `docs/milestones/` | The build, one milestone per file, each with acceptance criteria. Work on one at a time. |
| `design/` | The clickable prototype (31 screens), design tokens, icon set and screen inventory. |
| `contracts/` | JSON schemas, the CSP string, test fixtures and the permission test cases. Code is tested against these. |

## Stack

- **API:** Bun + Hono. Thin: keeps keys out of the browser, streams LLM responses, versions, logs usage.
- **Client:** Svelte SPA, served by the same process.
- **Database:** Bun's built-in SQLite (users, roles, usage, approvals, comments, drafts). Content lives in `DATA_DIR` as immutable revision files plus a content-addressed blob store (`blobs/sha256/…`).
- **LLM calls:** one `llm()` function using `fetch` against any OpenAI-compatible `/chat/completions`. No SDK, no gateway.
- **Check runner:** a separate worker (container or VM) on **Node** + Playwright, sitespeed.io and axe. Not inside the app, not on Bun.
- **Release log:** a git repository inside `DATA_DIR`.
- **Production agent:** a small agent plus web server on its own host. It never connects to the app.

## Rules that must never break

These are the security floor and the core invariants. Every one of them has, or must get, an automated test (`contracts/permission-cases.md`).

1. **The AI has no tools with consequences.** No git, no releases, no file system, no settings. It returns data that code validates.
2. **Nothing is overwritten.** Saved revisions and blobs are immutable. Writes are atomic (temp file, then rename). Drafts are private and autosaved; a draft becomes a numbered revision only when saved.
3. **AI output is validated against a schema** before use, with up to two retries that feed the error back. A brief field without a source is rejected and becomes "Not set yet."
4. **Code the AI wrote never runs on the app's site.** The app (`studio.internal`) and previews (`preview.internal`) are different sites, never subdomains of one domain. Previews get no cookies and `connect-src 'self'`. Every state-changing request checks Origin and a CSRF token.
5. **Production never connects to the app.** The app pushes over SFTP to production's inbox and reads its outbox (`docs/decisions.md` #1).
6. **Production only accepts releases signed by an Admin's passkey**, over the release hash plus an ever-increasing release number. Unfreeze, rollback, keys, hostnames and mail settings also need a passkey. Freeze needs only the app's signature.
7. **Built once, byte-identical.** One package, one SHA-256. Preview, staging and production serve the same bytes. No rebuilds, no injection.
8. **The site CSP is a contract** (`contracts/csp.txt`). Generated code: external scripts only, no inline scripts or inline event handlers, inline styles allowed. Zero CSP violations in the console is a check.
9. **Sections carry `data-section="<stable-id>"`** in shipped HTML, unique per page. No other annotation ever enters design HTML.
10. **The hard checks always run before staging**, and the security-floor checks always block (Checks tab, plan §16.5).
11. **Derived colours** are mixed in OKLab, clipped to sRGB, rounded to 8-bit hex, by one shared module used by both the editor and the validator (`contracts/fixtures/derived-colours.golden.json`).

## How to work in this repo

- **One milestone at a time.** Start in plan mode, read the milestone file and only the plan sections it cites, propose a plan, wait for approval.
- **Tests first.** Write the acceptance tests from the milestone file before the code. A milestone is done when they pass.
- **Spikes before features.** If a milestone depends on a spike that hasn't passed, stop and say so.
- **Ask before adding scope.** Don't add screens, settings or features the plan doesn't describe.
- **UI follows `design/`.** Use the tokens and the custom icon set; no stock icon libraries, no Inter, no emoji. Sentence case. Buttons say what happens; the consequence sits next to the action; the screen's one primary action sits bottom right in the decision bar.
- **Unknown facts are placeholders** in square brackets, never invented.
- **UI language:** English, with Danish supported (EN/DA per person).

## Commands

Fill these in during milestone M1 and keep them current:

```
bun install          # install
bun run dev          # app + client, watch mode
bun test             # unit and permission tests
bun run lint         # lint + type check
# check runner worker (Node): see worker/README.md
```
