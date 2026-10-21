# M4 · Design overview and editor

**Plan:** §5, §6. **Screens:** `DesignOverview.dc.html`, `DesignEditor.dc.html`, `BrandRules.dc.html`, `BrandAssets.dc.html`, `Media.dc.html`. **Decisions:** #7, #13, #14.

## Build
Overview (one direction per page by default; actions in the same place on every card), editor (outline, page at full size with section labels as overlay, device switch, inspector, prompt bar with scope, "Show another take on…" by axis, the Think new toggle, deviations with three outcomes, presence of other drafts), Brand and rules editors, media library, guide and code validators, `data-section` markers.

## Done when
- [x] Derived colours match `contracts/fixtures/derived-colours.golden.json` in both editor and validator (same module).
  *Test:* `packages/shared/test/colour.test.ts` › colour module (every golden vector); `apps/studio/test/brand.test.ts` › a derived colour whose hex is not the OKLab value is refused; `apps/studio/test/shell.e2e.ts` › brand and rules: an Admin builds 20% dark-green + white (the editor shows #d3dfdc from the same module)
- [x] The validators reject a font or colour outside the guide, an inline script, an inline event handler, and a duplicate `data-section`.
  *Test:* `packages/shared/test/design-validate.test.ts` (a fixture per rule, plus the review-of-M4 bypasses); `apps/studio/test/design.test.ts` › the validators at every level
- [x] One Lead per page is a database constraint; approved sections are locked.
  *Test:* `apps/studio/test/design.test.ts` › one Lead per page is a database constraint: a raw insert throws; › approval needs all 7 … and locks the section; `apps/studio/test/shell.e2e.ts` › design editor: an approved section is locked
- [x] Think new switches itself off after each generation.
  *Test:* `apps/studio/test/design-ai.test.ts` › the next level is follow, and no request state keeps think new; `apps/studio/test/shell.e2e.ts` › design editor: Think new is off after every generation

**Result (21 Oct):** Built by Sonnet agents in six steps, with the preview serving and the security-review fixes done on the strongest model. The defaults are decision #45. One security review (Opus, high) ran; every high and medium finding was fixed with tests (commit 5736ac7).

Deferred, as agreed in the plan:
- the critic and site digest;
- logo variants, lockups and exports;
- video;
- AI alt text;
- image metadata stripping (M8);
- the script pause control;
- AI instructions per phase.

Also open:
- **Brand and rules:** font upload and adding palette colours; accepting a guide proposal (they are recorded and listed only).
- **Editor:** previewing a take on the canvas before applying; content fields; overview thumbnails.
- **Stylesheet:** one stylesheet per artboard, locked while any section is approved; per-section styles would loosen that.
- **Previews:** media files inside artboard previews.
- **Token estimates:** not yet calibrated from history.
- **Danish:** strings are first drafts.
- **Review finding 5, partly done:** some guide-only colour gaps remain.
