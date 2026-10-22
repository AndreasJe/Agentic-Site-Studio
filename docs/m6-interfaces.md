# M6 interfaces (shared by the build, the worker and the app)

Working notes for M6. Decision #47 will replace this file when M6 is done.

## Package (built by `apps/studio/server/build/`, read by preview and the worker)
- **Archive:** a deterministic uncompressed ustar archive of the site files.
  - Entries are sorted by path, with mtime 0, mode 0644, uid and gid 0, and empty uname and gname.
  - It is written with the shared ustar writer in `packages/shared/src/release`.
- **Package hash:** the lowercase hex SHA-256 of the archive bytes.
  - The archive is also stored in the project's blob store, so its blob hash is `sha256:<package hash>`.
- **Index:** `<DATA_DIR>/<project>/packages/<rev>.json`, written once: `{ "rev", "hash", "archive": "sha256:<hash>", "files": { "<path>": "sha256:<blob>" } }`.
  - Every entry's bytes are stored as their own blob too, so the preview serves files without unpacking.
  - `files[path]` bytes are identical to the archive entry for that path.

## Check jobs (written by the app, run by `apps/worker/`)
- **Folders:** `<DATA_DIR>/checks/` holds `pending/`, `running/` and `results/`. A job moves `pending/<id>.json` → `running/<id>.json`, and its result is `results/<id>.json`. Every write is atomic: temp file, then rename.
- **Job:**
  ```json
  { "id": "<uuid>", "kind": "package" | "smoke",
    "project": "go", "rev": "go-r3",
    "archivePath": "<absolute path of the archive blob file>", "hash": "<package hash>",
    "settings": { "<checkId>": "off" | "warn" | "block" },
    "acceptances": [{ "rule": "color-contrast", "target": "#hero h1" }],
    "guide": { …guide.json… },
    "pinned": [{ "path": "lib/x.js", "sha256": "<hex>" }],
    "baselineArchivePath": "<optional, the last staged package>", "baselineHash": "<its package hash>",
    "smokeUrl": "<only for kind smoke: the staging URL>" }
  ```
- **Result:**
  ```json
  { "id", "kind", "hash", "startedAt", "finishedAt",
    "hashOk": true,
    "checks": [{ "id", "floor": true, "level": "block", "status": "pass" | "fail" | "warn" | "off" | "not-run",
                 "lowered": "can't be lowered" | null, "findings": [{ "message", "file"?, "target"?, "rule"? }] }],
    "blocked": true, "memory": { … } }
  ```
- **Review images (decision #50):** the visual check keeps, for each page and breakpoint that changed, a baseline, current and diff PNG in `results/<id>.images/`, beside the result.
  - The folder is written whole (a staging folder, then one rename) and each file atomically. Each PNG is at most 2 MB and at most 60 pages are kept; a page over the cap is left out.
  - The visual check in the result gains `"images": [{ "page": "index.html", "width": 1280, "baseline": "<stem>-baseline.png", "current": "<stem>-current.png", "diff": "<stem>-diff.png" }]`. `diff` is missing when the two sizes differ. Names are relative, `[A-Za-z0-9_]{1,80}-<width>-(baseline|current|diff).png`.
  - The app reads them once per run, checks every name against the result and the fixed form, the size and the PNG signature, and stores them as blobs. The preview site serves them under `/shots/<token>/<name>` (key label `preview-shots-v1`).
- **Hash check:** the worker refuses a job whose archive does not hash to `hash`. Its result is `hashOk: false, blocked: true`, and nothing is unpacked.
- **Check ids:**
  - Floor: `html`, `links`, `csp`, `inline-code`, `validators`, `svg`, `pinned`, `secrets`.
  - Advisory: `axe`, `heavy-profile`, `csp-console`, `visual`, `navigation`, `seo`, `performance` (a stub that reports `not-run`).
  - Smoke: `smoke`.
