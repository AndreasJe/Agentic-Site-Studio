<h1 align="center">
  <img src="docs/assets/logo/logo-light.svg" alt="Agentic Site Studio — we’ve got your back end" width="560">
</h1>

<p align="center">
  <b>Build static websites with AI, from brief to live site.</b><br>
  The AI drafts; people decide.
</p>

<p align="center">
  <img alt="Release 0.1.0-rc.1" src="https://img.shields.io/badge/release-0.1.0--rc.1-1E1E1C?style=flat-square">
  <img alt="Bun 1.4" src="https://img.shields.io/badge/Bun-1.4-565653?style=flat-square">
  <img alt="Node 24" src="https://img.shields.io/badge/Node-24-565653?style=flat-square">
  <img alt="Svelte" src="https://img.shields.io/badge/client-Svelte-565653?style=flat-square">
  <img alt="SQLite" src="https://img.shields.io/badge/data-SQLite-565653?style=flat-square">
  <img alt="Milestones M1–M8 built" src="https://img.shields.io/badge/milestones-M1%E2%80%93M8-B3361F?style=flat-square">
</p>

<p align="center">
  <a href="#the-workflow">Workflow</a> ·
  <a href="#screens">Screens</a> ·
  <a href="#how-it-fits-together">Architecture</a> ·
  <a href="#run-it-locally">Run it locally</a> ·
  <a href="#tests">Tests</a> ·
  <a href="#documentation">Documentation</a>
</p>

<p align="center">
  <img src="docs/assets/screenshots/project-home.png" alt="Project home: the workflow spine, the site being built shown large, and the next decision" width="900">
</p>

---

Site Studio is a web app where people without design or technical skills build static websites with AI. A **Creator** works on design and content. An **Admin** can do everything a Creator can, and also handles production, deployment and governance.

> [!IMPORTANT]
> **Status: release candidate `0.1.0-rc.1`.** Milestones M1–M8 are built and tested locally, with every AI feature running against a mock model. It has not yet run on real hosts. See [CHANGELOG.md](CHANGELOG.md) for what is in this release and what is still open.

## The workflow

| 01 · Brief | 02 · Structure | 03 · Design | 04 · Review | 05 · Staging | 06 · Publication |
|:--|:--|:--|:--|:--|:--|
| Blocks with sources; open questions never block | Site tree, menus, hidden pages and own addresses | One Lead per page; more takes only on request | Seven checkmarks per section, ticked by a person | The exact package that will go live | Released only with an Admin’s passkey |

Every screen answers three questions: where you are in the workflow, what the AI did, and what a person has to decide next.

## Screens

<table>
  <tr>
    <td width="50%"><img src="docs/assets/screenshots/brief.png" alt="Brief board"><br><b>Brief board</b> · blocks with their sources, guided questions and open questions</td>
    <td width="50%"><img src="docs/assets/screenshots/structure.png" alt="Structure workspace"><br><b>Structure</b> · site tree, menus by drag and drop, AI proposals as before and after</td>
  </tr>
  <tr>
    <td><img src="docs/assets/screenshots/design-editor.png" alt="Design editor"><br><b>Design editor</b> · outline, the page at full size, inspector and a prompt bar scoped to the selection</td>
    <td><img src="docs/assets/screenshots/review-mode.png" alt="Review mode"><br><b>Review mode</b> · the seven checkmarks per section, approval only when every section is done</td>
  </tr>
  <tr>
    <td><img src="docs/assets/screenshots/brand-and-rules.png" alt="Brand and rules"><br><b>Brand and rules</b> · fonts, colours, OKLab derived colours and a live contrast table</td>
    <td><img src="docs/assets/screenshots/waiting-for-you.png" alt="Waiting for you"><br><b>Waiting for you</b> · the Admin inbox across all projects</td>
  </tr>
  <tr>
    <td><img src="docs/assets/screenshots/admin-review.png" alt="Admin review page"><br><b>Publication review</b> · per-section comparison with production, then approve with a passkey</td>
    <td><img src="docs/assets/screenshots/failure-analysis.png" alt="Failure analysis"><br><b>Failure analysis</b> · a larger model explains a failed run and drafts a fix; a person decides</td>
  </tr>
  <tr>
    <td colspan="2"><img src="docs/assets/screenshots/deployment.png" alt="Deployment"><br><b>Deployment</b> · production paired over SFTP, health from its outbox, certificates, releases and the kill switch</td>
  </tr>
</table>

<sub>Screens are from the design prototype in <a href="design/"><code>design/</code></a>, which the app follows.</sub>

## How it fits together

```mermaid
flowchart LR
  subgraph internal["Internal network"]
    studio["<b>apps/studio</b><br/>API · client · SQLite<br/>studio.*"]
    preview["<b>preview site</b><br/>previews and staging<br/>preview.*"]
    worker["<b>apps/worker</b><br/>check runner"]
  end
  agent["<b>apps/agent</b><br/>production"]
  studio -- "built once, one hash" --> preview
  studio -- "check jobs" --> worker
  studio -- "SFTP: signed bundles,<br/>certificates, commands" --> agent
  agent -. "outbox: heartbeat,<br/>results, logs (read by the app)" .-> studio
```

| Part | Path | Runs on |
|---|---|---|
| App: API, client and preview site | `apps/studio` | Bun + Hono, Svelte SPA, SQLite |
| Check runner: HTML, links, CSP, axe, Lighthouse | `apps/worker` | Node + Playwright, on its own host |
| Production agent: inbox → live site → outbox | `apps/agent` | Its own host; it never connects to the app |
| Shared code: OKLab colours, validators, signing | `packages/shared` | Used by all three |

### Security in short

- **The AI has no tools with consequences.** It returns data that code validates; it can’t release, delete or change settings.
- **Nothing is overwritten.** Revisions and files are immutable; everyone edits in a private draft.
- **Generated code never runs on the app’s site.** The app (`studio.*`) and the previews (`preview.*`) are separate sites.
- **Built once, byte-identical.** Preview, staging and production serve the same package with the same hash.
- **Production only accepts releases signed with an Admin’s passkey**, and it never calls the app.

The full security floor is in [CLAUDE.md](CLAUDE.md#rules-that-must-never-break).

## Run it locally

| You need | Version |
|---|---|
| Bun | 1.4 |
| Node | 24 |
| Microsoft Edge | for the browser tests and the speed check |

```sh
bun install
cp .env.example .env     # then fill in DATA_DIR, APP_SECRET and the LLM_* values
bun run dev              # app at http://localhost:3000, preview at http://127.0.0.1:3001
```

> [!NOTE]
> The Admin screens need an Admin passkey. When the app starts, it writes a one-time setup code to its log for each Admin who has no passkey yet. Each code works once and expires after 24 hours.

## Tests

```sh
bun test                 # unit and permission tests
bun run lint             # Biome + type check + svelte-check
bun run test:browser     # browser tests (Node + installed Edge)
bun run test:worker      # check runner (Node)
bun run test:agent       # production agent
```

## Documentation

| | |
|---|---|
| [docs/plan.md](docs/plan.md) | The full plan (v4.0) |
| [docs/decisions.md](docs/decisions.md) | Developer decisions, which override the plan |
| [docs/milestones/](docs/milestones/) | M0–M8, each with Done-when criteria and a Result |
| [docs/vm-setup.md](docs/vm-setup.md) | Hosting on TAPPaaS: VMs, zones, TLS |
| [design/](design/) | The clickable prototype, tokens and icon set |
| [contracts/](contracts/) | JSON schemas, the site CSP, fixtures and the permission test cases |

<p align="center">
  <br>
  <img src="docs/assets/logo/logo-seal.svg" alt="Always Ship Static" width="120">
</p>

## License

Copyright (c) 2026 Andreas Jensen. Licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE): you may use, change and share it for non-commercial purposes only. Commercial use needs permission.
