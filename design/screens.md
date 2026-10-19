# Screen inventory

Each screen in `prototype/` with the route it suggests, who sees it, the plan sections behind it, what's interactive in the prototype, and the milestone that builds it. Routes are suggestions; change them in M1 if needed.

## Shared on every screen
- **Top bar:** brand, main menu (Creator: Projects, Media, Brand and rules · Admin adds Waiting for you with a badge, and Admin panel), avatar. The dashed "Prototype · view as" switch is prototype-only; don't build it.
- **Project bar** (inside a project): project title and IDs, the workflow spine (Brief, Structure, Design, Review, Staging, Publication; done / now / next, with the current screen underlined), Sitemap and Revisions tools, plus Project settings for Admins.
- **Decision bar** (sticky bottom): what the AI did, the consequence in words, secondary actions, then the one primary action, always bottom right.
- **Context line** on review screens: page · revision · Lead · how many sections changed or approved · package hash. Sections are named in plain words (Hero, Proof…), never by position number.

## Creator path
| File | Screen | Route | Plan | Interactive in the prototype | Milestone |
|---|---|---|---|---|---|
| `SignIn.dc.html` | Sign in (Creator password, Admin passkey) | `/sign-in` | §13.8 | EN/DA, simulated passkey | M1, M7 |
| `Projects.dc.html` | My projects | `/projects` | §16.6 | Slug preview for a new project | M1 |
| `ProjectHome.dc.html` | Project home | `/p/:project` | §3, §18 | EN/DA switch | M1 |
| `Brief.dc.html` | Brief board | `/p/:project/brief` | §4 | Block editor, structured calls to action | M2 |
| `Structure.dc.html` | Structure workspace | `/p/:project/structure` | §10.2–10.5 | Tree selection, drag and drop onto any menu, menu picker, AI before/after proposal | M3 |
| `NewPage.dc.html` | New page | `/p/:project/pages/new` | §10.1, §10.3, §10.4 | Page type, placement cards, live "Will live at" chip, drop zone | M3 |
| `DesignOverview.dc.html` | Design overview | `/p/:project/design` | §6.1, §6.2 | Show alternatives | M4 |
| `DesignEditor.dc.html` | Design editor | `/p/:project/design/:artboard` | §6.1–6.7 | Selection, device switch, takes by axis, Think new, generation, deviations, draft presence | M4 |
| `Review.dc.html` | Review mode | `/p/:project/review` | §13.2a | Seven checkmarks per section, approve revision, check-runner progress | M5 |
| `Staging.dc.html` | Staging and request publication | `/p/:project/staging` | §13.2, §13.3 | Request publication | M6 |
| `Revisions.dc.html` | Revisions and drafts | `/p/:project/revisions` | §11 | Branching timeline, continue from here, bring from, archive | M1 |
| `Media.dc.html` | Media library | `/media` | §6.8, §6.9 | Library level, categories, detail panel, upload | M4 |
| `MediaGenerate.dc.html` | Generate an image | `/media/generate` | §6.8 | **Next round, not in the first build** | — |
| `BrandRules.dc.html` | Brand and rules · type, colour, contrast, motion | `/brand` | §5.1–5.4 | OKLab derived-colour builder, live contrast table, motion tokens | M4 |
| `BrandAssets.dc.html` | Brand and rules · assets, logo studio, setup | `/brand/assets` | §5.5, §4.9, §6.4 | Logo recolour, variants, brief and design setup | M4 |

## Admin path
| File | Screen | Route | Plan | Interactive in the prototype | Milestone |
|---|---|---|---|---|---|
| `AdminInbox.dc.html` | Waiting for you | `/admin` | §10.5, §16.6 | Filters by group | M7 |
| `AdminFailure.dc.html` | Failure analysis (self-healing) | `/admin/failures/:id` | §13.5 | Send fix, hold with comment | M6 |
| `AdminReview.dc.html` | Review page for a publication request | `/admin/review/:revision` | §13.3 | Before/after sliders, warnings to acknowledge, one or two Admins, passkey approval, send back | M7 |
| `AddressRequest.dc.html` | Address request | `/admin/addresses/:id` | §10.4 | Approve, suggest another name, turn down | M7 |
| `AdminProjects.dc.html` | Projects overview | `/admin/projects` | §16.6 | Filters | M8 |
| `ProjectSettings.dc.html` | Project settings | `/p/:project/settings` | §16.6 | Member rights, stricter rules, backups, archive | M8 |
| `AdminDeployment.dc.html` | Deployment | `/admin/deployment` | §13.4, §13.6, §13.11 | Pairing wizard (SFTP, host key), outbox health, certificates, releases, freeze/unfreeze | M7 |
| `AdminGovernance.dc.html` | Governance | `/admin/governance` | §13.9, §16.3, §16.4 | Presets, Creator rights, two-person rule | M7 |
| `AdminChecks.dc.html` | Checks | `/admin/checks` | §16.5, §13.5 | Off / Warn / Block, failure-analysis setting | M6 |
| `AdminUsers.dc.html` | Users and keys | `/admin/users` | §13.8 | Invitations, pending key approval | M7 |
| `AdminMail.dc.html` | Notifications and mail | `/admin/mail` | §13.7 | SMTP or Microsoft 365 OAuth | M7 |
| `AdminBackups.dc.html` | Backups | `/admin/backups` | §12.2 | Targets, back up now, restore with typed confirmation | M8 |
| `AdminModels.dc.html` | Models | `/admin/models` | §15 | Endpoints, role and action routing (incl. analyst) | M8 |
| `AdminUsage.dc.html` | Usage statistics | `/admin/usage` | §15 | Filters (figures are placeholders) | M8 |
| `AdminLanguages.dc.html` | Site settings · Languages | `/admin/languages` | decisions #9 | Toggle, add language | M7 |
| `AdminSetup.dc.html` | Setup checklist | `/admin/setup` | §22 | Checklists with progress | M8 |

`Main.dc.html` is the mood board (three directions; Gallery was chosen). It isn't a screen.
