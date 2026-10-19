# M4 · Design overview and editor

**Plan:** §5, §6. **Screens:** `DesignOverview.dc.html`, `DesignEditor.dc.html`, `BrandRules.dc.html`, `BrandAssets.dc.html`, `Media.dc.html`. **Decisions:** #7, #13, #14.

## Build
Overview (one direction per page by default; actions in the same place on every card), editor (outline, page at full size with section labels as overlay, device switch, inspector, prompt bar with scope, "Show another take on…" by axis, the Think new toggle, deviations with three outcomes, presence of other drafts), Brand and rules editors, media library, guide and code validators, `data-section` markers.

## Done when
- [ ] Derived colours match `contracts/fixtures/derived-colours.golden.json` in both editor and validator (same module).
- [ ] The validators reject a font or colour outside the guide, an inline script, an inline event handler, and a duplicate `data-section`.
- [ ] One Lead per page is a database constraint; approved sections are locked.
- [ ] Think new switches itself off after each generation.
